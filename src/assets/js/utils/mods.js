/**
 * Gestion des mods d'une instance : lecture des métadonnées des .jar, vérification de
 * compatibilité (loader, version de Minecraft, dépendances), activation / import / suppression.
 *
 * Un mod désactivé est simplement renommé en ".jar.disabled" (ignoré par tous les loaders).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------------------------------------------------ */
/* Lecture minimale d'archives zip (un .jar est un zip)                */
/* ------------------------------------------------------------------ */

/**
 * Source de lecture : fichier (lecture partielle, seuls les octets utiles sont lus)
 * ou buffer (jar imbriqué).
 */
function openSource(input) {
    if (Buffer.isBuffer(input)) {
        return { size: input.length, read: (pos, len) => input.subarray(pos, pos + len), close() { } };
    }
    let fd = fs.openSync(input, 'r');
    let size = fs.fstatSync(fd).size;
    return {
        size,
        /** Lit `len` octets à la position `pos`. */
        read(pos, len) {
            let buf = Buffer.alloc(len);
            let n = fs.readSync(fd, buf, 0, len, pos);
            return buf.subarray(0, n);
        },
        close() { fs.closeSync(fd); }
    };
}

/** Renvoie Map<nom, Buffer> des entrées pour lesquelles `wanted(nom)` est vrai. */
function readZipEntries(input, wanted) {
    let src = openSource(input);
    try {
        let tailLen = Math.min(src.size, 65557);
        let tail = src.read(src.size - tailLen, tailLen);
        let eocd = -1;
        for (let i = tail.length - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('archive invalide');

        let count = tail.readUInt16LE(eocd + 10);
        let cdSize = tail.readUInt32LE(eocd + 12);
        let cdOffset = tail.readUInt32LE(eocd + 16);
        if (cdOffset === 0xFFFFFFFF) throw new Error('archive zip64 non prise en charge');
        let cd = src.read(cdOffset, cdSize);

        let out = new Map();
        let p = 0;
        for (let i = 0; i < count && p + 46 <= cd.length; i++) {
            if (cd.readUInt32LE(p) !== 0x02014b50) break;
            let method = cd.readUInt16LE(p + 10);
            let compSize = cd.readUInt32LE(p + 20);
            let nameLen = cd.readUInt16LE(p + 28);
            let extraLen = cd.readUInt16LE(p + 30);
            let commentLen = cd.readUInt16LE(p + 32);
            let localOffset = cd.readUInt32LE(p + 42);
            let name = cd.toString('utf8', p + 46, p + 46 + nameLen).split('\\').join('/');
            p += 46 + nameLen + extraLen + commentLen;
            if (!wanted(name)) continue;

            let local = src.read(localOffset, 30);
            let start = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
            let data = src.read(start, compSize);
            try {
                if (method === 0) out.set(name, Buffer.from(data));
                else if (method === 8) out.set(name, zlib.inflateRawSync(data));
            } catch { /* entrée illisible : ignorée */ }
        }
        return out;
    } finally {
        src.close();
    }
}

/* ------------------------------------------------------------------ */
/* Versions                                                            */
/* ------------------------------------------------------------------ */

/**
 * Version numérique (« 1.21.8 » → [1, 21, 8]) ; null pour un snapshot ou un format inconnu.
 * @param {string} v
 * @returns {number[]|null}
 */
function parseVersion(v) {
    if (v === undefined || v === null) return null;
    let clean = String(v).trim().replace(/^v/i, '').split(/[-+]/)[0];
    if (!/^\d+(\.\d+)*$/.test(clean)) return null;
    return clean.split('.').map(Number);
}

/**
 * Compare deux versions numériques.
 * @returns {number} < 0, 0 ou > 0
 */
function compare(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        let d = (a[i] || 0) - (b[i] || 0);
        if (d) return d;
    }
    return 0;
}

/** Combine des résultats tri-état (true / false / null = inconnu) en ET logique. */
function all(results) {
    if (results.some(r => r === false)) return false;
    if (results.some(r => r === null)) return null;
    return true;
}

/** Combine des résultats tri-état (true / false / null = inconnu) en OU logique. */
function any(results) {
    if (results.some(r => r === true)) return true;
    if (results.some(r => r === null)) return null;
    return false;
}

/** Prédicat de version façon Fabric/Quilt : ">=1.21 <1.21.2", "~1.20.1", "1.21.x", ["1.20", "1.20.1"]... */
function matchFabricPredicate(predicate, version) {
    if (predicate === undefined || predicate === null) return true;
    if (Array.isArray(predicate)) return predicate.length ? any(predicate.map(p => matchFabricPredicate(p, version))) : true;
    if (typeof predicate === 'object') {
        if (predicate.any) return matchFabricPredicate(predicate.any, version);
        if (predicate.all) return all([].concat(predicate.all).map(p => matchFabricPredicate(p, version)));
        if (predicate.versions !== undefined) return matchFabricPredicate(predicate.versions, version);
        return null;
    }
    let target = parseVersion(version);
    if (!target) return null; // snapshot ou version exotique : on ne bloque pas

    let text = String(predicate).trim();
    if (!text || text === '*') return true;
    if (text.includes('||')) return any(text.split('||').map(p => matchFabricPredicate(p, version)));

    let tokens = text.replace(/(>=|<=|>|<|=|~|\^)\s+/g, '$1').split(/\s+/);
    return all(tokens.map(token => {
        let [, op = '', raw] = token.match(/^(>=|<=|>|<|=|~|\^)?(.*)$/);
        if (raw === '*' || raw === '') return true;

        // Jokers : 1.21.x / 1.21.*
        if (/[xX*]/.test(raw)) {
            let parts = raw.split('.');
            let fixed = parts.slice(0, parts.findIndex(p => /^[xX*]$/.test(p)));
            let wanted = parseVersion(fixed.join('.'));
            if (!wanted) return null;
            return compare(target.slice(0, wanted.length), wanted) === 0;
        }

        let v = parseVersion(raw);
        if (!v) return null;
        let c = compare(target, v);
        switch (op) {
            case '>=': return c >= 0;
            case '>': return c > 0;
            case '<=': return c <= 0;
            case '<': return c < 0;
            case '~': {
                let upper = v.length >= 2 ? [v[0], v[1] + 1] : [v[0] + 1];
                return c >= 0 && compare(target, upper) < 0;
            }
            case '^': return c >= 0 && compare(target, [v[0] + 1]) < 0;
            default: return c === 0;
        }
    }));
}

/** Intervalle Maven (Forge / NeoForge) : "[1.20.1,1.21)", "[1.21,)", "[1.20.4]". */
function matchMavenRange(range, version) {
    if (range === undefined || range === null) return true;
    let text = String(range).trim();
    if (!text || text === '*' || text.includes('${')) return null;
    let target = parseVersion(version);
    if (!target) return null;

    let ranges = text.match(/[\[(][^\])]*[\])]/g);
    if (!ranges) return true; // version "recommandée" sans crochets : Forge l'accepte
    return any(ranges.map(r => {
        let inner = r.slice(1, -1);
        if (!inner.includes(',')) {
            let v = parseVersion(inner);
            return v ? compare(target, v) === 0 : null;
        }
        let [low, high] = inner.split(',').map(s => s.trim());
        let ok = true;
        if (low) {
            let v = parseVersion(low);
            if (!v) return null;
            ok = ok && (r[0] === '[' ? compare(target, v) >= 0 : compare(target, v) > 0);
        }
        if (high) {
            let v = parseVersion(high);
            if (!v) return null;
            ok = ok && (r[r.length - 1] === ']' ? compare(target, v) <= 0 : compare(target, v) < 0);
        }
        return ok;
    }));
}

/* ------------------------------------------------------------------ */
/* Métadonnées des mods                                                */
/* ------------------------------------------------------------------ */

const IGNORED_DEPENDENCIES = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilted_fabric_api', 'forge', 'neoforge', 'javafml', 'lowcodefml']);

/**
 * Décode un JSON de mod, en tolérant les retours à la ligne bruts dans les chaînes.
 * @param {Buffer} buffer
 */
function parseJson(buffer) {
    let text = buffer.toString('utf8').replace(/^﻿/, '');
    try {
        return JSON.parse(text);
    } catch {
        // Certains mods ont des retours à la ligne bruts dans leurs chaînes.
        return JSON.parse(text.replace(/[\u0000-\u001F]+/g, ' '));
    }
}

/** Parseur TOML volontairement minimal, suffisant pour mods.toml / neoforge.mods.toml. */
function parseModsToml(text) {
    let root = { mods: [], dependencies: {} };
    let current = root;
    let lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;

        let table = line.match(/^\[\[\s*([^\]]+?)\s*\]\]/);
        if (table) {
            let name = table[1];
            current = {};
            if (name === 'mods') root.mods.push(current);
            else if (name.startsWith('dependencies.')) {
                let id = name.slice('dependencies.'.length).replace(/"/g, '');
                (root.dependencies[id] = root.dependencies[id] || []).push(current);
            }
            continue;
        }
        if (/^\[[^\[]/.test(line)) { current = {}; continue; }

        let kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
        if (!kv) continue;
        let [, key, value] = kv;
        if (value.startsWith("'''") || value.startsWith('"""')) {
            let quote = value.slice(0, 3);
            let rest = value.slice(3);
            while (!rest.includes(quote) && i + 1 < lines.length) rest += '\n' + lines[++i];
            value = rest.slice(0, rest.indexOf(quote));
        } else if (/^["']/.test(value)) {
            let q = value[0];
            value = value.slice(1, value.indexOf(q, 1));
        } else {
            value = value.replace(/\s+#.*$/, '').trim();
            if (value === 'true' || value === 'false') value = value === 'true';
        }
        current[key] = value;
    }
    return root;
}

/**
 * Icône d'un mod en data URL (ignorée au-delà de 300 Ko).
 * @param {Map<string, Buffer>} entries Entrées lues dans le jar
 * @param {string} iconPath
 * @returns {string|null}
 */
function pickIcon(entries, iconPath) {
    if (!iconPath) return null;
    let data = entries.get(iconPath.replace(/^\//, ''));
    if (!data || data.length > 300000) return null;
    let ext = path.extname(iconPath).toLowerCase();
    let mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${data.toString('base64')}`;
}

/**
 * Chemin de l'icône déclarée par un mod Fabric/Quilt (chaîne ou tailles multiples).
 * @returns {string|null}
 */
function fabricIconPath(icon) {
    if (!icon) return null;
    if (typeof icon === 'string') return icon;
    let sizes = Object.keys(icon).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
    let best = sizes.filter(s => s <= 128).pop() || sizes[0];
    return icon[best];
}

/**
 * Normalise les dépendances (objet Fabric ou tableau Quilt) en `{id, versions}`.
 * @returns {Array<{id: string, versions: any}>}
 */
function normalizeDepends(depends) {
    if (!depends) return [];
    if (Array.isArray(depends)) {
        return depends.map(d => typeof d === 'string' ? { id: d.split('@')[0], versions: '*' } : { id: d.id, versions: d.versions }).filter(d => d.id && !d.optional);
    }
    return Object.entries(depends).map(([id, versions]) => ({ id, versions }));
}

/** Ids fournis par les jars imbriqués (Fabric API embarque ~50 modules par exemple). */
function nestedProvides(entries) {
    let ids = [];
    for (let [name, data] of entries) {
        if (!name.endsWith('.jar')) continue;
        try {
            let nested = readZipEntries(data, n => n === 'fabric.mod.json' || n === 'quilt.mod.json');
            let f = nested.get('fabric.mod.json');
            if (f) { let j = parseJson(f); ids.push(j.id, ...(j.provides || [])); }
            let q = nested.get('quilt.mod.json');
            if (q) { let j = parseJson(q).quilt_loader || {}; ids.push(j.id, ...(j.provides || []).map(p => p.id || p)); }
        } catch { }
    }
    return ids.filter(Boolean);
}

/**
 * Métadonnées d'un mod Fabric ou Quilt.
 * @param {Map<string, Buffer>} entries
 */
function readFabricLike(entries, file) {
    let fabric = entries.get('fabric.mod.json');
    let quilt = entries.get('quilt.mod.json');

    if (quilt) {
        let json = parseJson(quilt).quilt_loader || {};
        let meta = json.metadata || {};
        let depends = normalizeDepends(json.depends);
        let mc = depends.find(d => d.id === 'minecraft');
        return {
            loader: 'quilt',
            id: json.id,
            name: meta.name || json.id,
            version: json.version,
            description: meta.description,
            icon: fabricIconPath(meta.icon),
            mc: mc ? mc.versions : undefined,
            mcSyntax: 'fabric',
            depends: depends.map(d => d.id).filter(id => !IGNORED_DEPENDENCIES.has(id)),
            provides: (json.provides || []).map(p => p.id || p),
            nested: true
        };
    }

    let json = parseJson(fabric);
    let depends = json.depends || {};
    return {
        loader: 'fabric',
        id: json.id,
        name: json.name || json.id,
        version: json.version,
        description: json.description,
        icon: fabricIconPath(json.icon),
        mc: depends.minecraft,
        mcSyntax: 'fabric',
        depends: Object.keys(depends).filter(id => !IGNORED_DEPENDENCIES.has(id)),
        provides: json.provides || [],
        nested: Array.isArray(json.jars) && json.jars.length > 0
    };
}

/**
 * Métadonnées d'un mod Forge ou NeoForge.
 * @param {Map<string, Buffer>} entries
 * @param {"forge"|"neoforge"} loader
 */
function readForgeLike(entries, loader) {
    let toml = parseModsToml(entries.get(loader === 'neoforge' ? 'META-INF/neoforge.mods.toml' : 'META-INF/mods.toml').toString('utf8'));
    let mod = toml.mods[0] || {};
    let deps = toml.dependencies[mod.modId] || [];
    let mc = deps.find(d => d.modId === 'minecraft');
    let manifest = entries.get('META-INF/MANIFEST.MF')?.toString('utf8') || '';
    let version = String(mod.version || '');
    if (version.includes('${file.jarVersion}')) version = manifest.match(/Implementation-Version:\s*(.+)/)?.[1]?.trim() || '';
    let required = deps.filter(d => (d.mandatory === true || d.type === 'required' || (d.type === undefined && d.mandatory === undefined)) && d.side !== 'SERVER');
    return {
        loader,
        id: mod.modId,
        name: mod.displayName || mod.modId,
        version,
        description: mod.description,
        icon: mod.logoFile || toml.logoFile,
        mc: mc ? mc.versionRange : undefined,
        mcSyntax: 'maven',
        depends: required.map(d => d.modId).filter(id => id && !IGNORED_DEPENDENCIES.has(id)),
        provides: toml.mods.slice(1).map(m => m.modId).filter(Boolean),
        nested: false
    };
}

let infoCache = new Map();

/** Métadonnées d'un .jar (ou .jar.disabled). Ne lève jamais : `loader: null` si non reconnu. */
export function readModInfo(file) {
    let stat;
    try { stat = fs.statSync(file); } catch { return null; }
    let key = `${file}|${stat.size}|${stat.mtimeMs}`;
    if (infoCache.has(key)) return infoCache.get(key);

    let base = path.basename(file).replace(/\.disabled$/i, '');
    let info = { loader: null, id: null, name: base.replace(/\.jar$/i, ''), version: '', icon: null, depends: [], provides: [] };
    try {
        let metaNames = new Set(['fabric.mod.json', 'quilt.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml', 'META-INF/MANIFEST.MF']);
        let entries = readZipEntries(file, n => metaNames.has(n));

        let parsed = null;
        if (entries.has('quilt.mod.json') || entries.has('fabric.mod.json')) parsed = readFabricLike(entries, file);
        else if (entries.has('META-INF/neoforge.mods.toml')) parsed = readForgeLike(entries, 'neoforge');
        else if (entries.has('META-INF/mods.toml')) parsed = readForgeLike(entries, 'forge');

        if (parsed) {
            let wantIcon = parsed.icon ? parsed.icon.replace(/^\//, '') : null;
            let extra = readZipEntries(file, n => n === wantIcon || (parsed.nested && /^META-INF\/jars\/.+\.jar$/.test(n)));
            info = {
                ...info,
                ...parsed,
                name: parsed.name || info.name,
                icon: pickIcon(extra, parsed.icon),
                provides: [...parsed.provides, ...(parsed.nested ? nestedProvides(extra) : [])]
            };
        }
    } catch (err) {
        info.error = err.message;
    }
    infoCache.set(key, info);
    return info;
}

/* ------------------------------------------------------------------ */
/* Compatibilité                                                       */
/* ------------------------------------------------------------------ */

const LOADER_NAMES = { none: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
const DEPENDENCY_NAMES = { 'fabric-api': 'Fabric API', fabric: 'Fabric API', 'cloth-config': 'Cloth Config', cloth_config: 'Cloth Config', architectury: 'Architectury API', yet_another_config_lib_v3: 'YACL', yacl: 'YACL', modmenu: 'Mod Menu', geckolib: 'GeckoLib', 'owo': 'oωo-lib', kotlinforforge: 'Kotlin for Forge', fabric_language_kotlin: 'Fabric Language Kotlin', sodium: 'Sodium', iris: 'Iris', indium: 'Indium', 'cloth-config2': 'Cloth Config', konkrete: 'Konkrete', melody: 'Melody', placeholder_api: 'Placeholder API', 'placeholder-api': 'Placeholder API', balm: 'Balm', 'forgeconfigapiport': 'Forge Config API Port', puzzleslib: 'Puzzles Lib', resourcefullib: 'Resourceful Lib' };

/**
 * Formats de mods qu'un loader sait charger (Quilt charge aussi les mods Fabric).
 * @param {string} instanceLoader
 * @param {string} mc Version de Minecraft
 * @returns {string[]}
 */
function acceptedLoaders(instanceLoader, mc) {
    switch (instanceLoader) {
        case 'fabric': return ['fabric'];
        case 'quilt': return ['quilt', 'fabric'];
        case 'forge': return ['forge'];
        case 'neoforge': return mc === '1.20.1' ? ['neoforge', 'forge'] : ['neoforge'];
        default: return [];
    }
}

/** Rend un intervalle de versions lisible : "[1.20.1,1.20.2)" → "1.20.1", ">=1.21 <1.22" → "1.21 à 1.22". */
function versionLabel(range, syntax) {
    if (Array.isArray(range)) return range.map(r => versionLabel(r, syntax)).join(' ou ');
    let text = String(range).trim();
    if (syntax === 'maven') {
        return (text.match(/[\[(][^\])]*[\])]/g) || [text]).map(r => {
            let inner = r.replace(/^[\[(]|[\])]$/g, '');
            if (!inner.includes(',')) return inner;
            let [low, high] = inner.split(',').map(s => s.trim());
            let lowV = parseVersion(low), highV = parseVersion(high);
            // [1.20.1,1.20.2) → une seule version
            if (lowV && highV && r.startsWith('[') && r.endsWith(')') && lowV.length === 3 && highV.length === 3
                && lowV[0] === highV[0] && lowV[1] === highV[1] && highV[2] === lowV[2] + 1) return low;
            if (low && high) return `${low} à ${high}`;
            return low ? `${low} ou plus récent` : `antérieur à ${high}`;
        }).join(' ou ');
    }
    let m = text.match(/^>=\s*([^\s]+)\s+<\s*([^\s]+)$/);
    if (m) return `${m[1].replace(/-$/, '')} à ${m[2].replace(/-$/, '')}`;
    let tilde = text.match(/^~\s*(\d+)\.(\d+)(\.\d+)?/);
    if (tilde) return tilde[3] ? `${tilde[1]}.${tilde[2]}.x (à partir de ${tilde[1]}.${tilde[2]}${tilde[3]})` : `${tilde[1]}.${tilde[2]}.x`;
    return text.replace(/^>=\s*(.+)$/, '$1 ou plus récent').replace(/-.*$/, '');
}

/**
 * Nom lisible d'une dépendance (« fabric-api » → « Fabric API »).
 * @param {string} id
 * @returns {string}
 */
export function dependencyName(id) {
    return DEPENDENCY_NAMES[id] || id;
}

/**
 * @returns {{ errors: string[], warnings: string[], unknown: boolean }}
 * errors   : le mod ne fonctionnera très probablement pas (mauvais loader / version).
 * warnings : dépendances manquantes.
 * unknown  : métadonnées illisibles, compatibilité impossible à vérifier.
 */
export function checkCompatibility(info, instance, installed = []) {
    let errors = [];
    let warnings = [];
    let type = instance?.loadder?.loadder_type || 'none';
    let mc = instance?.loadder?.minecraft_version;

    if (type === 'none') {
        errors.push("Instance Vanilla : les mods ne fonctionnent qu'avec un mod loader (Fabric, Forge...).");
        return { errors, warnings, unknown: false };
    }
    if (!info || !info.loader) {
        return { errors, warnings, unknown: true };
    }

    if (!acceptedLoaders(type, mc).includes(info.loader)) {
        errors.push(`Mod ${LOADER_NAMES[info.loader]}, alors que l'instance utilise ${LOADER_NAMES[type]}.`);
    }

    let mcOk = info.mcSyntax === 'maven' ? matchMavenRange(info.mc, mc) : matchFabricPredicate(info.mc, mc);
    if (mcOk === false) {
        errors.push(`Prévu pour Minecraft ${versionLabel(info.mc, info.mcSyntax)}, l'instance est en ${mc}.`);
    }

    let available = new Set();
    for (let mod of installed) {
        if (!mod.enabled || !mod.info) continue;
        if (mod.info.id) available.add(mod.info.id);
        for (let id of mod.info.provides || []) available.add(id);
    }
    let hasFabricApi = available.has('fabric-api') || available.has('fabric');
    let missing = (info.depends || []).filter(id => {
        if (available.has(id) || id === info.id) return false;
        if (hasFabricApi && (id === 'fabric' || id.startsWith('fabric-'))) return false;
        return true;
    });
    if (missing.length) warnings.push(`Nécessite : ${[...new Set(missing.map(dependencyName))].join(', ')}`);

    return { errors, warnings, unknown: false };
}

/* ------------------------------------------------------------------ */
/* Fichiers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Dossier des mods d'une instance.
 * @param {string} instanceDir
 * @returns {string}
 */
export function modsFolder(instanceDir) {
    return `${instanceDir}/mods`;
}

/** Liste des mods (.jar actifs et .jar.disabled), triés par nom. */
export function listMods(instanceDir) {
    let dir = modsFolder(instanceDir);
    if (!fs.existsSync(dir)) return [];
    let mods = fs.readdirSync(dir)
        .filter(f => /\.jar$/i.test(f) || /\.jar\.disabled$/i.test(f))
        .map(file => ({
            file,
            path: `${dir}/${file}`,
            enabled: !/\.disabled$/i.test(file),
            info: readModInfo(`${dir}/${file}`)
        }));
    return mods.sort((a, b) => String(a.info?.name || a.file).localeCompare(String(b.info?.name || b.file), 'fr', { sensitivity: 'base' }));
}

/**
 * Active ou désactive un mod (renommage en `.jar.disabled`).
 * @param {string} instanceDir
 * @param {string} file Nom du fichier actuel
 * @param {boolean} enabled
 * @returns {string} Nouveau nom du fichier
 */
export function setModEnabled(instanceDir, file, enabled) {
    let dir = modsFolder(instanceDir);
    let base = file.replace(/\.disabled$/i, '');
    let from = `${dir}/${file}`;
    let to = enabled ? `${dir}/${base}` : `${dir}/${base}.disabled`;
    if (from === to) return file;
    if (fs.existsSync(to)) throw new Error(`Un fichier "${path.basename(to)}" existe déjà.`);
    fs.renameSync(from, to);
    return path.basename(to);
}

/**
 * Copie un .jar dans le dossier des mods.
 * @param {string} instanceDir
 * @param {string} source Chemin du fichier à importer
 * @returns {string} Nom du fichier copié
 */
export function importMod(instanceDir, source) {
    let dir = modsFolder(instanceDir);
    fs.mkdirSync(dir, { recursive: true });
    let target = `${dir}/${path.basename(source)}`;
    fs.copyFileSync(source, target);
    return path.basename(target);
}

/**
 * Supprime un mod.
 * @param {string} instanceDir
 * @param {string} file
 */
export function deleteMod(instanceDir, file) {
    fs.rmSync(`${modsFolder(instanceDir)}/${file}`, { force: true });
}

export const _test = { matchFabricPredicate, matchMavenRange, parseModsToml, readZipEntries };

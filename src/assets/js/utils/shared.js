/**
 * Données partagées entre TOUTES les instances (officielles et locales) :
 *   - saves/ et screenshots/ : jonctions (liens de dossier) vers <gamePath>/shared/...
 *   - servers.dat            : copie synchronisée (Minecraft le réécrit en le remplaçant,
 *                              ce qui casserait un lien de fichier).
 *
 * Au premier passage d'une instance, son contenu existant est déplacé dans le dossier
 * partagé (renommé en cas de doublon) et sa liste de serveurs est fusionnée.
 */

const fs = require('fs');
const path = require('path');

const SHARED_DIRS = ['saves', 'screenshots'];
const SERVERS_FILE = 'servers.dat';
const MARKER = '.venstone-shared';

export function sharedPath(gamePath) {
    return `${gamePath}/shared`;
}

function isLink(p) {
    try {
        return fs.lstatSync(p).isSymbolicLink();
    } catch {
        return false;
    }
}

function samePath(a, b) {
    let norm = p => path.resolve(p).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    return norm(a) === norm(b);
}

/** La lib supprime les fichiers inconnus des instances "verify" : on ne partage que ce qu'elle ignore. */
function canShare(instance, entry) {
    return !instance.verify || (instance.ignored || []).includes(entry);
}

function uniqueName(dir, name, label) {
    if (!fs.existsSync(`${dir}/${name}`)) return name;
    let ext = fs.statSync(`${dir}/${name}`).isDirectory() ? '' : path.extname(name);
    let base = name.slice(0, name.length - ext.length);
    let candidate = `${base} (${label})${ext}`;
    for (let i = 2; fs.existsSync(`${dir}/${candidate}`); i++) candidate = `${base} (${label} ${i})${ext}`;
    return candidate;
}

/** Déplace le contenu d'un vrai dossier d'instance vers le dossier partagé. */
function migrateFolder(source, target, label) {
    for (let entry of fs.readdirSync(source)) {
        let destName = uniqueName(target, entry, label);
        try {
            fs.renameSync(`${source}/${entry}`, `${target}/${destName}`);
        } catch (err) {
            // Autre volume / fichier verrouillé : copie puis suppression.
            fs.cpSync(`${source}/${entry}`, `${target}/${destName}`, { recursive: true });
            fs.rmSync(`${source}/${entry}`, { recursive: true, force: true });
        }
    }
    fs.rmdirSync(source);
}

function linkFolder(instanceDir, sharedDir, name, label) {
    let link = `${instanceDir}/${name}`;
    let target = `${sharedDir}/${name}`;
    fs.mkdirSync(target, { recursive: true });

    if (isLink(link)) {
        let current = null;
        try { current = fs.readlinkSync(link); } catch { }
        if (current && samePath(current, target) && fs.existsSync(link)) return;
        fs.unlinkSync(link); // lien cassé ou pointant ailleurs
    } else if (fs.existsSync(link)) {
        if (!fs.statSync(link).isDirectory()) fs.renameSync(link, `${link}.old`);
        else migrateFolder(link, target, label);
    }

    fs.symlinkSync(path.resolve(target), path.resolve(link), 'junction');
}

/* ------------------------------------------------------------------ */
/* NBT minimal (servers.dat est un NBT non compressé)                 */
/* ------------------------------------------------------------------ */

function readNBT(buf) {
    let o = 0;
    let str = () => { let len = buf.readUInt16BE(o); o += 2; let s = buf.toString('utf8', o, o + len); o += len; return s; };
    let payload = type => {
        switch (type) {
            case 1: return buf.readInt8(o++);
            case 2: { let v = buf.readInt16BE(o); o += 2; return v; }
            case 3: { let v = buf.readInt32BE(o); o += 4; return v; }
            case 4: { let v = buf.readBigInt64BE(o); o += 8; return v; }
            case 5: { let v = buf.readFloatBE(o); o += 4; return v; }
            case 6: { let v = buf.readDoubleBE(o); o += 8; return v; }
            case 7: { let len = buf.readInt32BE(o); o += 4; let v = buf.subarray(o, o + len); o += len; return Buffer.from(v); }
            case 8: return str();
            case 9: {
                let itemType = buf.readUInt8(o++); let len = buf.readInt32BE(o); o += 4;
                let items = []; for (let i = 0; i < len; i++) items.push(payload(itemType));
                return { itemType, items };
            }
            case 10: {
                let entries = [];
                for (;;) {
                    let t = buf.readUInt8(o++);
                    if (t === 0) break;
                    let name = str();
                    entries.push({ type: t, name, value: payload(t) });
                }
                return entries;
            }
            case 11: { let len = buf.readInt32BE(o); o += 4; let v = []; for (let i = 0; i < len; i++) { v.push(buf.readInt32BE(o)); o += 4; } return v; }
            case 12: { let len = buf.readInt32BE(o); o += 4; let v = []; for (let i = 0; i < len; i++) { v.push(buf.readBigInt64BE(o)); o += 8; } return v; }
            default: throw new Error(`Tag NBT inconnu : ${type}`);
        }
    };
    let rootType = buf.readUInt8(o++);
    if (rootType !== 10) throw new Error('servers.dat invalide');
    let name = str();
    return { name, value: payload(10) };
}

function writeNBT(root) {
    let parts = [];
    let push = b => parts.push(b);
    let u8 = v => { let b = Buffer.alloc(1); b.writeUInt8(v); push(b); };
    let i32 = v => { let b = Buffer.alloc(4); b.writeInt32BE(v); push(b); };
    let str = s => { let d = Buffer.from(s, 'utf8'); let b = Buffer.alloc(2); b.writeUInt16BE(d.length); push(b); push(d); };
    let payload = (type, v) => {
        switch (type) {
            case 1: { let b = Buffer.alloc(1); b.writeInt8(v); return push(b); }
            case 2: { let b = Buffer.alloc(2); b.writeInt16BE(v); return push(b); }
            case 3: return i32(v);
            case 4: { let b = Buffer.alloc(8); b.writeBigInt64BE(v); return push(b); }
            case 5: { let b = Buffer.alloc(4); b.writeFloatBE(v); return push(b); }
            case 6: { let b = Buffer.alloc(8); b.writeDoubleBE(v); return push(b); }
            case 7: i32(v.length); return push(v);
            case 8: return str(v);
            case 9: u8(v.itemType); i32(v.items.length); return v.items.forEach(item => payload(v.itemType, item));
            case 10: v.forEach(e => { u8(e.type); str(e.name); payload(e.type, e.value); }); return u8(0);
            case 11: i32(v.length); return v.forEach(i32);
            case 12: i32(v.length); return v.forEach(x => { let b = Buffer.alloc(8); b.writeBigInt64BE(x); push(b); });
        }
    };
    u8(10); str(root.name); payload(10, root.value);
    return Buffer.concat(parts);
}

function serverList(root) {
    return root.value.find(e => e.name === 'servers' && e.type === 9);
}

function serverIp(compound) {
    return String(compound.find(e => e.name === 'ip')?.value || '').trim().toLowerCase();
}

/** Ajoute à `base` les serveurs de `extra` qui n'y sont pas encore (comparaison par IP). */
export function mergeServers(baseBuf, extraBuf) {
    let base = readNBT(baseBuf);
    let extra = readNBT(extraBuf);
    let extraList = serverList(extra);
    if (!extraList || !extraList.value.items.length) return baseBuf;

    let baseList = serverList(base);
    if (!baseList) {
        base.value.push({ type: 9, name: 'servers', value: { itemType: 10, items: [] } });
        baseList = serverList(base);
    }
    if (baseList.value.itemType !== 10 && baseList.value.items.length === 0) baseList.value.itemType = 10;

    let known = new Set(baseList.value.items.map(serverIp));
    let added = 0;
    for (let server of extraList.value.items) {
        let ip = serverIp(server);
        if (!ip || known.has(ip)) continue;
        known.add(ip);
        baseList.value.items.push(server);
        added++;
    }
    return added ? writeNBT(base) : baseBuf;
}

function copyKeepTime(from, to) {
    fs.copyFileSync(from, to);
    let { atime, mtime } = fs.statSync(from);
    fs.utimesSync(to, atime, mtime);
}

/**
 * Synchronise servers.dat entre l'instance et le dossier partagé.
 * `merge` : premier passage de l'instance → fusion des deux listes au lieu d'écraser.
 */
export function syncServers(gamePath, instanceDir, merge = false) {
    let shared = `${sharedPath(gamePath)}/${SERVERS_FILE}`;
    let local = `${instanceDir}/${SERVERS_FILE}`;
    let hasShared = fs.existsSync(shared);
    let hasLocal = fs.existsSync(local);
    fs.mkdirSync(sharedPath(gamePath), { recursive: true });

    if (!hasShared && !hasLocal) return;
    if (hasShared && !hasLocal) return copyKeepTime(shared, local);
    if (!hasShared && hasLocal) return copyKeepTime(local, shared);

    if (merge) {
        try {
            let merged = mergeServers(fs.readFileSync(shared), fs.readFileSync(local));
            fs.writeFileSync(shared, merged);
            return copyKeepTime(shared, local);
        } catch (err) {
            console.warn('[Shared] fusion de servers.dat impossible, la liste partagée est conservée :', err.message);
            fs.copyFileSync(local, `${local}.backup`);
            return copyKeepTime(shared, local);
        }
    }

    let sharedTime = fs.statSync(shared).mtimeMs;
    let localTime = fs.statSync(local).mtimeMs;
    if (Math.abs(sharedTime - localTime) < 1000) return;
    if (localTime > sharedTime) copyKeepTime(local, shared);
    else copyKeepTime(shared, local);
}

/** À appeler avant chaque lancement : met en place les liens et synchronise les serveurs. */
export function prepareSharedData(gamePath, instanceDir, instance) {
    fs.mkdirSync(instanceDir, { recursive: true });
    let shared = sharedPath(gamePath);
    let firstTime = !fs.existsSync(`${instanceDir}/${MARKER}`);

    for (let dir of SHARED_DIRS) {
        if (!canShare(instance, dir)) {
            console.warn(`[Shared] ${instance.name} : "${dir}" non partagé (instance vérifiée sans exclusion).`);
            continue;
        }
        linkFolder(instanceDir, shared, dir, instance.name);
    }
    if (canShare(instance, SERVERS_FILE)) syncServers(gamePath, instanceDir, firstTime);

    if (firstTime) fs.writeFileSync(`${instanceDir}/${MARKER}`, 'Les mondes, serveurs et captures sont partagés via ../../shared\n');
}

/** Après la fermeture du jeu : remonte la liste de serveurs modifiée vers le dossier partagé. */
export function finishSharedData(gamePath, instanceDir, instance) {
    if (canShare(instance, SERVERS_FILE)) syncServers(gamePath, instanceDir, false);
}

/** Retire les liens partagés d'un dossier d'instance (avant sa suppression). */
export function unlinkSharedData(instanceDir) {
    for (let dir of SHARED_DIRS) {
        let link = `${instanceDir}/${dir}`;
        if (isLink(link)) fs.unlinkSync(link);
    }
}

export const _nbt = { readNBT, writeNBT };

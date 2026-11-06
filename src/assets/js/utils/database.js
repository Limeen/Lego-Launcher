/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 *
 * Stockage local (comptes, configuration) dans une base SQLite.
 *
 * Remplace les appels à node-bdd, qui posaient deux problèmes :
 *  - updateData() rendait la main AVANT la fin de l'écriture, sur une nouvelle connexion à
 *    chaque appel : des sauvegardes successives se marchaient dessus et étaient perdues ;
 *  - les valeurs étaient insérées dans la requête entre apostrophes : une valeur contenant
 *    un ' (nom d'instance, argument JVM...) faisait échouer l'écriture en silence.
 * Ici : une seule connexion en mode sérialisé et des paramètres liés.
 * Le fichier et le schéma (id, json_data, createdAt, updatedAt) sont inchangés.
 */

const sqlite3 = require('sqlite3');
const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

let dev = process.env.NODE_ENV === 'dev';

let connectionPromise = null;
let readyTables = new Map();

function connection() {
    if (!connectionPromise) {
        connectionPromise = ipcRenderer.invoke('path-user-data').then(userData => new Promise((resolve, reject) => {
            let dir = path.resolve(`${userData}${dev ? '../..' : '/databases'}`);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            let db = new sqlite3.Database(path.join(dir, `Databases.${dev ? 'sqlite' : 'db'}`), err => {
                if (err) return reject(err);
                db.serialize(); // toutes les requêtes s'exécutent dans l'ordre d'appel
                db.configure('busyTimeout', 5000);
                resolve(db);
            });
        }));
        connectionPromise.catch(() => { connectionPromise = null; });
    }
    return connectionPromise;
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this);
    }));
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}

function tableName(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Nom de table invalide : ${name}`);
    return name;
}

async function table(name) {
    let db = await connection();
    name = tableName(name);
    if (!readyTables.has(name)) {
        readyTables.set(name, run(db, `CREATE TABLE IF NOT EXISTS ${name}(id INTEGER PRIMARY KEY, json_data TEXT, createdAt DATETIME, updatedAt DATETIME)`));
    }
    await readyTables.get(name);
    return { db, name };
}

function parse(row) {
    if (!row) return undefined;
    let data;
    try {
        data = JSON.parse(row.json_data);
    } catch (err) {
        console.error(`[Database] entrée ${row.id} illisible :`, err);
        return undefined;
    }
    if (data && typeof data === 'object') data.ID = row.id;
    return data;
}

class database {
    async createData(tableName, data) {
        let { db, name } = await table(tableName);
        let now = new Date().toISOString();
        let result = await run(db, `INSERT INTO ${name}(json_data, createdAt, updatedAt) VALUES(?, ?, ?)`, [JSON.stringify(data), now, now]);
        return { ...data, ID: result.lastID };
    }

    async readData(tableName, key = 1) {
        let { db, name } = await table(tableName);
        return parse(await get(db, `SELECT * FROM ${name} WHERE id = ?`, [key]));
    }

    async readAllData(tableName) {
        let { db, name } = await table(tableName);
        let rows = await all(db, `SELECT * FROM ${name} ORDER BY id`);
        return rows.map(parse).filter(Boolean);
    }

    async updateData(tableName, data, key = 1) {
        let { db, name } = await table(tableName);
        let { ID, ...clean } = data || {};
        await run(db, `UPDATE ${name} SET json_data = ?, updatedAt = ? WHERE id = ?`, [JSON.stringify(clean), new Date().toISOString(), key]);
    }

    async deleteData(tableName, key = 1) {
        let { db, name } = await table(tableName);
        await run(db, `DELETE FROM ${name} WHERE id = ?`, [key]);
    }
}

export default database;

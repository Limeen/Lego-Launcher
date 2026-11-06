/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { ipcRenderer } = require('electron')
const { Status } = require('minecraft-java-core')
const fs = require('fs');
const crypto = require('crypto');
const pkg = require('../package.json');

import config from './utils/config.js';
import database from './utils/database.js';
import logger from './utils/logger.js';
import popup from './utils/popup.js';
import { skin2D } from './utils/skin.js';
import slider from './utils/slider.js';

async function setBackground(theme) {
    if (typeof theme == 'undefined') {
        let databaseLauncher = new database();
        let configClient = await databaseLauncher.readData('configClient');
        theme = configClient?.launcher_config?.theme || "auto"
        theme = await ipcRenderer.invoke('is-dark-theme', theme).then(res => res)
    }
    let background
    let body = document.body;
    body.className = theme ? 'dark global' : 'light global';
    if (fs.existsSync(`${__dirname}/assets/images/background/easterEgg`) && Math.random() < 0.005) {
        let backgrounds = fs.readdirSync(`${__dirname}/assets/images/background/easterEgg`);
        let Background = backgrounds[Math.floor(Math.random() * backgrounds.length)];
        background = `url(./assets/images/background/easterEgg/${Background})`;
    } else if (fs.existsSync(`${__dirname}/assets/images/background/${theme ? 'dark' : 'light'}`)) {
        let backgrounds = fs.readdirSync(`${__dirname}/assets/images/background/${theme ? 'dark' : 'light'}`);
        let Background = backgrounds[Math.floor(Math.random() * backgrounds.length)];
        background = `linear-gradient(#00000080, #00000080), url(./assets/images/background/${theme ? 'dark' : 'light'}/${Background})`;
    }
    body.style.backgroundImage = background ? background : theme ? '#000' : '#fff';
    body.style.backgroundSize = 'cover';
    body.style.backgroundColor = '#292929ff';
    body.style.backgroundRepeat = 'no-repeat';
    body.style.backgroundPosition = 'center center';
    body.style.backgroundAttachment = 'scroll';
}

async function changePanel(id) {
    let panel = document.querySelector(`.${id}`);
    let active = document.querySelector(`.active`)
    if (active) active.classList.toggle("active");
    panel.classList.add("active");
}

async function appdata() {
    return await ipcRenderer.invoke('appData').then(path => path)
}

async function addAccount(data) {
    let div = document.createElement("div");
    div.classList.add("account");
    div.id = data.ID;
    div.innerHTML = `
        <div class="profile-image" style="background-image: url(https://venstone.xyz/skins/?pseudo=${data.name});"></div>
        <div class="profile-infos">
            <div class="profile-pseudo">${data.name}</div>
            <div class="profile-uuid">${data.uuid}</div>
        </div>
        <div class="delete-profile" id="${data.ID}">
            <div class="icon-account-delete delete-profile-icon"></div>
        </div>
    `
    return document.querySelector('.accounts-list').appendChild(div);
}

async function accountSelect(data) {
    if (!data) return;
    let account = document.getElementById(`${data.ID}`);
    let activeAccount = document.querySelector('.account-select')
    headplayer(`${data.name}`);

    if (activeAccount) activeAccount.classList.remove('account-select');
    if (account) account.classList.add('account-select');
    window.dispatchEvent(new CustomEvent('venstone:account-changed'));
}

// async function headplayer(skinBase64) {
//     let skin = await new skin2D().creatHeadTexture(skinBase64);
//     document.querySelector(".player-head").style.backgroundImage = `url(${skin})`;
// }

 function headplayer(pseudo) {
    const imageUrl = `https://venstone.xyz/skins/?pseudo=${encodeURIComponent(pseudo)}`;
    const defaultImage = "assets/images/default/steve.png";

    const img = new Image();
    img.onload = function () {
        // L'image s'est chargée correctement
        document.querySelector(".player-head").style.backgroundImage = `url(${imageUrl})`;
    };
    img.onerror = function () {
        // L'image n'a pas pu être chargée
        document.querySelector(".player-head").style.backgroundImage = `url(${defaultImage})`;
    };
    img.src = imageUrl;

    document.getElementById("player-username").textContent = `${pseudo}`;
}


/**
 * Compte hors-ligne (crack) avec un UUID stable, identique à celui que calcule un
 * serveur en online-mode=false ("OfflinePlayer:<pseudo>", UUID v3). Sans ça, l'UUID
 * changeait à chaque démarrage et les données joueur des mondes solo étaient perdues.
 */
function offlineAccount(name) {
    let hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
    hash[6] = (hash[6] & 0x0f) | 0x30;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    let uuid = hash.toString('hex');
    return {
        access_token: uuid,
        client_token: uuid,
        uuid,
        name,
        user_properties: '{}',
        meta: { online: false, type: 'Mojang' }
    };
}

async function setStatus(opt, offline = false) {
    let nameServerElement = document.querySelector('.server-status-name')
    let statusServerElement = document.querySelector('.server-status-text')
    let playerCount = document.querySelector('.status-player-count')
    let playersOnline = document.querySelector('.status-player-count .player-count')

    let showOffline = (text) => {
        statusServerElement.classList.add('red')
        statusServerElement.innerHTML = text
        playerCount.classList.add('red')
        playersOnline.innerHTML = '0'
    }

    if (opt?.nameServer) nameServerElement.innerHTML = opt.nameServer
    if (!opt?.ip) return showOffline(offline ? '<span class="orange">Mode hors-ligne</span>' : 'Aucune connexion')

    let requestId = (setStatus.requestId = (setStatus.requestId || 0) + 1)
    let statusServer = await new Status(opt.ip, opt.port).getStatus().then(res => res).catch(err => ({ error: err }));
    if (requestId !== setStatus.requestId) return // un statut plus récent a été demandé

    if (statusServer && !statusServer.error) {
        statusServerElement.classList.remove('red')
        playerCount.classList.remove('red')
        statusServerElement.innerHTML = '<span class="green">En ligne</span>'
        playersOnline.innerHTML = statusServer.playersConnect
    } else {
        showOffline(offline ? '<span class="orange">Mode hors-ligne</span>' : 'Aucune connexion')
    }
}


export {
    appdata as appdata,
    changePanel as changePanel,
    config as config,
    database as database,
    logger as logger,
    popup as popup,
    setBackground as setBackground,
    skin2D as skin2D,
    addAccount as addAccount,
    accountSelect as accountSelect,
    slider as Slider,
    pkg as pkg,
    setStatus as setStatus,
    offlineAccount as offlineAccount
}
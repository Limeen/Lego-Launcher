const { config } = require('./assets/js/utils.js');
const { status } = require('minecraft-java-core');

config.info().then(async (config)  => {
    let StatusServer = (await status.StatusServer(config.ip_server, parseInt(config.port)));
    
    if(!StatusServer){
        document.querySelector(".player-connect-number").innerHTML = "Serveur hors-ligne";
        document.querySelector(".player-connect").innerHTML = "Serveur hors-ligne";
    } else {
        document.querySelector(".player-connect").innerHTML = ""
        if(StatusServer.players.online === 0){
            document.querySelector(".player-connect-number").innerHTML = `Serveur en ligne`;
            document.querySelector(".player-connect").innerHTML = `0/12`;
        } else if (StatusServer.players.online === 1){
            document.querySelector(".player-connect-number").innerHTML = `${StatusServer.players.online} joueur actuellement connecté`;
            head(StatusServer.players)      
        } else {
            document.querySelector(".player-connect-number").innerHTML = `${StatusServer.players.online} joueurs actuellement connectés`;
            head(StatusServer.players)
        }
    }
})


function head(StatusServer) {
    if (!!StatusServer.sample) {
        StatusServer.sample.forEach(element => {
            document.querySelector(".player-connect").innerHTML += `<div><img class="users" src="https://mc-heads.net/head/${element.name}"><b class="users"> ${element.name}</b></div>`      
        });
    } else {
        document.querySelector(".player-connect").innerHTML += `<div><b class="users">Indisponible...</b></div>`
    }
}

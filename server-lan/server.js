// Settings

var PORT = parseInt(process.env.PORT || "3000", 10);                // Server port
    LOGLEVEL=0,               // Log level
    CLIENTROOT="../client/",  // Game client path
    ROOMTIMELIMIT=1200000;    // Autoclose rooms after 20 minutes of no join in/out

// Initialization

var http = require('http'),
    fs = require('fs'),
    path = require('path'),
    os = require('os'),
    netplayserver = require(CLIENTROOT+"js/netplay-server.js");
    mysql = require('mysql2/promise');

// Database

var db = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 5
});

async function initDatabase() {

    await db.query(`
        CREATE TABLE IF NOT EXISTS player_stats (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nickname VARCHAR(50) NOT NULL UNIQUE,
            joins INT NOT NULL DEFAULT 0,
            last_room VARCHAR(100),
            last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS room_history (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nickname VARCHAR(50) NOT NULL,
            room_name VARCHAR(100) NOT NULL,
            joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

}

async function recordJoin(roomName, nickname) {

    if (!nickname || !roomName)
        return;

    await db.execute(`
        INSERT INTO player_stats
            (nickname, joins, last_room, last_seen)
        VALUES
            (?, 1, ?, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
            joins = joins + 1,
            last_room = ?,
            last_seen = CURRENT_TIMESTAMP
    `, [nickname, roomName, roomName]);

    await db.execute(`
        INSERT INTO room_history
            (nickname, room_name)
        VALUES
            (?, ?)
    `, [nickname, roomName]);

}

// Webapp server

var app = http.createServer(async function (request, response) {

    var url = request.url.split("?")[0];

    if (url === "/health") {

        try {

            await db.query("SELECT 1");

            response.writeHead(200, {
                "Content-Type": "application/json"
            });

            response.end(JSON.stringify({
                status: "ok",
                database: "ok"
            }));

        } catch (error) {

            response.writeHead(503, {
                "Content-Type": "application/json"
            });

            response.end(JSON.stringify({
                status: "error",
                database: "unavailable"
            }));

        }

        return;
    }

    if (url === "/api/stats") {

        try {

            var [rows] = await db.query(`
                SELECT
                    nickname,
                    joins,
                    last_room,
                    last_seen
                FROM player_stats
                ORDER BY joins DESC, nickname ASC
                LIMIT 20
            `);

            response.writeHead(200, {
                "Content-Type": "application/json"
            });

            response.end(JSON.stringify(rows));

        } catch (error) {

            response.writeHead(500, {
                "Content-Type": "application/json"
            });

            response.end(JSON.stringify({
                error: "database_error"
            }));

        }

        return;
    }

    var filePath = '.' + request.url.replace(/\?.*/,"");
    if (filePath == './')
        filePath = './index.html';

    var extname = path.extname(filePath);
    var contentType = 'text/html';
    switch (extname) {
        case '.js':
            contentType = 'text/javascript';
            break;
        case '.css':
            contentType = 'text/css';
            break;
        case '.json':
            contentType = 'application/json';
            break;
        case '.png':
            contentType = 'image/png';
            break;
         case '.svg':
            contentType = 'image/svg+xml';
            break;      
        case '.jpg':
            contentType = 'image/jpg';
            break;
        case '.wav':
            contentType = 'audio/wav';
            break;
        case '.ogg':
            contentType = 'audio/ogg';
            break;
        case '.mp4':
            contentType = 'audio/mp4';
            break;
    }

    fs.readFile(CLIENTROOT+filePath, function(error, content) {
        if (error) {
            if(error.code == 'ENOENT'){
                fs.readFile('./404.html', function(error, content) {
                    response.writeHead(200, { 'Content-Type': contentType });
                    response.end(content, 'utf-8');
                });
            }
            else {
                response.writeHead(500);
                response.end('Sorry, check with the site admin for error: '+error.code+' ..\n');
                response.end(); 
            }
        }
        else {
            response.writeHead(200, { 'Content-Type': contentType });
            response.end(content, 'utf-8');
        }
    });
});

// Socket server

var io = require('socket.io')(app);
var netplayServer=new netplayserver.NetplayServer({
    logLevel:LOGLEVEL,
    roomTimeLimit:ROOMTIMELIMIT,
    netcodes:netplayserver,
    sendToPlayer:function(socket,type,data) {
        socket.emit(type,data);
    }
});

// Server core

io.on('connection', function(socket) {

    netplayServer.log(2,"<connect>","-",socket.id);
    
    socket.on(netplayserver.NETCODE_JOINROOM, function (data) {

        var result = netplayServer.joinRoom(
            data[0],
            data[1],
            data[2],
            socket.id,
            socket
        );

        netplayServer.log(
            2,
            "joinRoom",
            "-",
            result
        );

        if (result === "ok") {
            recordJoin(data[0], data[1])
                .catch(function(error) {
                    console.error("Database error:", error);
                });
        }

    });

    socket.on(netplayserver.NETCODE_LEAVEROOM, function () {
        netplayServer.log(2,"leaveRoom","-",netplayServer.leaveRoom(socket.id));
    });

    socket.on(netplayserver.NETCODE_SETCONFIRM, function (data) {
        netplayServer.log(3,"setConfirm","-",netplayServer.setConfirm(socket.id,data));
    });

    socket.on(netplayserver.NETCODE_FREEZEROOM, function (data) {
        netplayServer.log(3,"freezeRoom","-",netplayServer.freezeRoom(socket.id,data));
    });

    socket.on(netplayserver.NETCODE_UPDATESETUP, function (data) {
         netplayServer.log(3,"updateSetup","-",netplayServer.updateSetup(socket.id,data));
    });

    socket.on(netplayserver.NETCODE_BROADCAST, function (data) {
        netplayServer.broadcast(socket.id,netplayserver.NETCODE_DATA,data);
    });

    socket.on(netplayserver.NETCODE_SENDEVENT, function (data) {
        netplayServer.send(data[0],netplayserver.NETCODE_EVENT,data[1]);
    });

    socket.on("disconnect", () => {
        netplayServer.log(2,"<disconnect>","-",socket.id);
        netplayServer.leaveRoom(socket.id);
    });

});

setInterval(function(){
   netplayServer.flushRooms();
},10000)

const nets = os.networkInterfaces();

for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal)
            netplayServer.log(0,"<startup>","-","Server ready at http://"+net.address+":"+PORT);
    }
}

async function startServer() {

    try {

        await initDatabase();

        app.listen(PORT, "0.0.0.0", function() {
            console.log("PvP server ready on port " + PORT);
        });

    } catch (error) {

        console.error("Unable to initialize database:", error);
        process.exit(1);

    }

}

startServer();





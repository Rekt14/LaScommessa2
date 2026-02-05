const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Connessione MongoDB (Inserirai la tua stringa dopo)
// mongoose.connect(process.env.MONGO_URI);

const rooms = {}; // Stato locale delle stanze attive

io.on('connection', (socket) => {
    console.log('Utente connesso:', socket.id);

    // Creazione Stanza
    socket.on('createRoom', (data) => {
        const roomId = Math.random().toString(36).substring(2, 7);
        rooms[roomId] = {
            id: roomId,
            creator: data.playerName,
            maxPlayers: data.maxPlayers,
            players: [{ id: socket.id, name: data.playerName, points: 0 }],
            status: 'waiting'
        };
        socket.join(roomId);
        socket.emit('roomCreated', rooms[roomId]);
        io.emit('updateRoomList', Object.values(rooms).filter(r => r.status === 'waiting'));
    });

    // Unirsi a una stanza
    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomId];
        if (room && room.players.length < room.maxPlayers) {
            room.players.push({ id: socket.id, name: data.playerName, points: 0 });
            socket.join(data.roomId);
            
            if (room.players.length == room.maxPlayers) {
                room.status = 'playing';
                io.to(data.roomId).emit('startGame', room);
            }
            io.emit('updateRoomList', Object.values(rooms).filter(r => r.status === 'waiting'));
        }
    });

    socket.on('disconnect', () => {
        // Logica per rimuovere giocatore e chiudere stanza se vuota
    });
});

server.listen(process.env.PORT || 3000, () => console.log('Server pronto'));

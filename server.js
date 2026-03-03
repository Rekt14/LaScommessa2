const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] } 
});

// --- CONFIGURAZIONE MONGODB ---
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);
let db, roomsCollection;

// --- LOGICA GIOCO ---
const suits = ["Denari", "Spade", "Bastoni", "Coppe"];
const values = [
    { n: "Asso", p: 11 }, { n: "Re", p: 10 }, { n: "Cavallo", p: 9 }, { n: "Fante", p: 8 },
    { n: "7", p: 7 }, { n: "6", p: 6 }, { n: "5", p: 5 }, { n: "4", p: 4 }, { n: "3", p: 3 }, { n: "2", p: 2 }
];
const suitOrder = { Denari: 4, Spade: 3, Bastoni: 2, Coppe: 1 };

let rooms = {};
const disconnectTimers = {};

// Helper per salvare su DB
async function syncRoom(roomId) {
    if (!rooms[roomId]) return;
    try {
        await roomsCollection.updateOne(
            { id: roomId },
            { $set: rooms[roomId] },
            { upsert: true }
        );
    } catch (err) {
        console.error("Errore salvataggio DB:", err);
    }
}

// Helper per eliminare da DB
async function deleteRoomFromDB(roomId) {
    try {
        await roomsCollection.deleteOne({ id: roomId });
    } catch (err) {
        console.error("Errore eliminazione DB:", err);
    }
}

function createDeck() {
    let deck = [];
    suits.forEach(s => values.forEach(v => deck.push({ suit: s, name: v.n, power: v.p })));
    return deck.sort(() => Math.random() - 0.5);
}

// --- CONNESSIONE E AVVIO ---
async function startServer() {
    try {
        await client.connect();
        db = client.db("laScommessaDB");
        roomsCollection = db.collection("laScommessa2");
        console.log("Connesso a MongoDB");

        // Recupero stanze esistenti per gestire crash/riavvii
        const existingRooms = await roomsCollection.find({}).toArray();
        existingRooms.forEach(r => { rooms[r.id] = r; });
        console.log(`Recuperate ${existingRooms.length} stanze dal database.`);

        io.on('connection', (socket) => {
            socket.on('handshake', (userId) => {
                socket.userId = userId;
                for (const roomId in rooms) {
                    const room = rooms[roomId];
                    const p = room.players.find(p => p.userId === userId);
                    if (p) {
                        p.id = socket.id;
                        p.online = true;
                        if (disconnectTimers[userId]) {
                            clearTimeout(disconnectTimers[userId]);
                            delete disconnectTimers[userId];
                        }
                        socket.join(roomId);
                        io.to(roomId).emit('playerBack', { userId: p.userId, newSocketId: socket.id });
                        socket.emit('reSyncGame', { room, hand: p.hand, myId: socket.id });
                        syncRoom(roomId); // Aggiorna stato online su DB
                        break;
                    }
                }
            });

            socket.on('createRoom', async (data) => {
                await leaveOldRooms(socket.userId, socket);
                const roomId = Math.random().toString(36).substring(2, 7);
                rooms[roomId] = {
                    id: roomId,
                    creator: data.playerName,
                    creatorUserId: socket.userId,
                    maxPlayers: data.maxPlayers,
                    players: [{ 
                        id: socket.id, 
                        userId: socket.userId, 
                        name: data.playerName, 
                        points: 0, tricksWon: 0, bet: null, ready: false, online: true 
                    }],
                    status: 'waiting',
                    currentRound: 1,
                    currentTrick: [],
                    turnIndex: 0,
                    tricksInRound: 0,
                    roundStarterIndex: 0 
                };
                socket.join(roomId);
                await syncRoom(roomId);
                socket.emit('roomCreated', rooms[roomId]);
                io.emit('updateRoomList', Object.values(rooms).filter(r => r.status === 'waiting'));
            });

            socket.on('joinRoom', async (data) => {
                await leaveOldRooms(socket.userId, socket);
                const room = rooms[data.roomId];
                if (room && room.players.length < room.maxPlayers) {
                    room.players.push({ 
                        id: socket.id, 
                        userId: socket.userId, 
                        name: data.playerName, 
                        points: 0, tricksWon: 0, bet: null, ready: false, online: true 
                    });
                    socket.join(data.roomId);
                    if (room.players.length == room.maxPlayers) {
                        room.status = 'playing';
                        io.to(room.id).emit('startGame', room);
                        startNewRound(room);
                    }
                    await syncRoom(data.roomId);
                    io.emit('updateRoomList', Object.values(rooms).filter(r => r.status === 'waiting'));
                }
            });

            socket.on('placeBet', ({ roomId, bet }) => {
                const room = rooms[roomId];
                if (!room || room.players[room.turnIndex].userId !== socket.userId) return;
                const player = room.players.find(p => p.userId === socket.userId);
                if (player) player.bet = bet;
                
                io.to(roomId).emit('playerBetPlaced', { playerId: socket.id, bet });

                if (room.players.every(p => p.bet !== null)) {
                    room.turnIndex = room.roundStarterIndex;
                    io.to(roomId).emit('betsConfirmed', room.players);
                    io.to(room.players[room.turnIndex].id).emit('yourTurn');
                } else {
                    room.turnIndex = (room.turnIndex + 1) % room.players.length;
                    io.to(room.players[room.turnIndex].id).emit('betTurn', { message: "Tocca a te!" });
                }
                syncRoom(roomId);
            });

            socket.on('playCard', ({ roomId, card }) => {
                const room = rooms[roomId];
                if (!room || room.players[room.turnIndex].userId !== socket.userId) return;

                const currentPlayer = room.players[room.turnIndex];
                const cardInServerHand = currentPlayer.hand.find(c => c.suit === card.suit && c.name === card.name && !c.played);
                if (cardInServerHand) cardInServerHand.played = true;

                room.currentTrick.push({ owner: socket.id, userId: socket.userId, card });
                io.to(roomId).emit('cardPlayed', { owner: socket.id, userId: socket.userId, card });

                if (room.currentTrick.length === room.players.length) {
                    resolveTrick(room);
                } else {
                    room.turnIndex = (room.turnIndex + 1) % room.players.length;
                    io.to(room.players[room.turnIndex].id).emit('yourTurn');
                }
                syncRoom(roomId);
            });

            socket.on('readyForNextRound', ({ roomId }) => {
                const room = rooms[roomId];
                if (!room) return;
                const player = room.players.find(p => p.userId === socket.userId);
                if (player) player.ready = true;
                if (room.players.every(p => p.ready)) {
                    room.currentRound++;
                    room.players.forEach(p => p.ready = false);
                    startNewRound(room);
                }
                syncRoom(roomId);
            });

            socket.on('disconnect', () => {
                for (const roomId in rooms) {
                    const room = rooms[roomId];
                    const p = room.players.find(p => p.userId === socket.userId);
                    if (p) {
                        p.online = false;
                        syncRoom(roomId);
                        io.to(roomId).emit('playerAway', { userId: p.userId, timeout: 60 });

                        disconnectTimers[p.userId] = setTimeout(async () => {
                            if (!p.online) {
                                console.log(`[DB-PULIZIA] Timeout stanza ${roomId}`);
                                io.to(roomId).emit('playerDisconnected', { name: p.name });
                                delete rooms[roomId];
                                await deleteRoomFromDB(roomId);
                                delete disconnectTimers[p.userId];
                            }
                        }, 60000); 
                        break;
                    }
                }
            });
        });
    } catch (e) {
        console.error("Fallimento startup:", e);
    }
}

async function leaveOldRooms(userId, socket) {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        const playerIndex = room.players.findIndex(p => p.userId === userId);
        if (playerIndex !== -1) {
            room.players.splice(playerIndex, 1);
            socket.leave(roomId);
            if (room.players.length === 0) {
                delete rooms[roomId];
                await deleteRoomFromDB(roomId);
            } else {
                io.to(roomId).emit('updateRoomData', room);
                await syncRoom(roomId);
            }
        }
    }
}

function startNewRound(room) {
    const deck = createDeck();
    room.currentTrick = [];
    room.tricksInRound = 0;
    room.roundStarterIndex = room.currentRound === 1 ? Math.floor(Math.random() * room.players.length) : (room.roundStarterIndex + 1) % room.players.length;
    room.turnIndex = room.roundStarterIndex;

    room.players.forEach((p) => { 
        p.hand = deck.splice(0, room.currentRound).map(card => ({ ...card, played: false })); 
        p.bet = null; p.tricksWon = 0; 
    });

    room.players.forEach(p => {
        const opponentsData = room.players.map(opp => ({
            id: opp.id, userId: opp.userId, name: opp.name, points: opp.points, tricksWon: opp.tricksWon, bet: opp.bet,
            hand: (room.currentRound === 1) ? opp.hand : null 
        }));
        io.to(p.id).emit('yourHand', { hand: p.hand, round: room.currentRound, opponents: opponentsData });
    });

    io.to(room.id).emit('newRoundStarted', { round: room.currentRound, starterId: room.players[room.turnIndex].id });
    io.to(room.players[room.turnIndex].id).emit('betTurn');
    syncRoom(room.id);
}

function resolveTrick(room) {
    let winnerObj = room.currentTrick[0];
    for (let i = 1; i < room.currentTrick.length; i++) {
        const cur = room.currentTrick[i];
        if (cur.card.power > winnerObj.card.power || (cur.card.power === winnerObj.card.power && suitOrder[cur.card.suit] > suitOrder[winnerObj.card.suit])) {
            winnerObj = cur;
        }
    }
    const winningPlayer = room.players.find(p => p.userId === winnerObj.userId);
    winningPlayer.tricksWon++;
    room.turnIndex = room.players.findIndex(p => p.userId === winnerObj.userId);
    room.tricksInRound++;

    setTimeout(() => {
        io.to(room.id).emit('trickResolved', { winnerId: winnerObj.owner, players: room.players });
        room.currentTrick = [];
        if (room.tricksInRound === room.currentRound) {
            endRound(room);
        } else {
            io.to(room.players[room.turnIndex].id).emit('yourTurn');
        }
        syncRoom(room.id);
    }, 2000);
}

function endRound(room) {
    room.players.forEach(p => {
        const gained = (p.tricksWon === p.bet) ? (10 + p.bet) : -Math.abs(p.bet - p.tricksWon);
        p.points += gained;
    });

    if (room.currentRound === 10) {
        setTimeout(async () => {
            delete rooms[room.id];
            await deleteRoomFromDB(room.id);
        }, 1000);
    } else {
        io.to(room.id).emit('roundEnded', { players: room.players, nextRound: room.currentRound + 1 });
    }
    syncRoom(room.id);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server pronto sulla porta ${PORT}`);
    startServer();
});

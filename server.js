const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] } 
});

const suits = ["Denari", "Spade", "Bastoni", "Coppe"];
const values = [
    { n: "Asso", p: 11 }, { n: "Re", p: 10 }, { n: "Cavallo", p: 9 }, { n: "Fante", p: 8 },
    { n: "7", p: 7 }, { n: "6", p: 6 }, { n: "5", p: 5 }, { n: "4", p: 4 }, { n: "3", p: 3 }, { n: "2", p: 2 }
];
const suitOrder = { Denari: 4, Spade: 3, Bastoni: 2, Coppe: 1 };

const rooms = {};

function createDeck() {
    let deck = [];
    suits.forEach(s => values.forEach(v => deck.push({ suit: s, name: v.n, power: v.p })));
    return deck.sort(() => Math.random() - 0.5);
}

const disconnectTimers = {};

io.on('connection', (socket) => {

    socket.on('handshake', (userId) => {
    socket.userId = userId;
    for (const roomId in rooms) {
        const room = rooms[roomId];
        const p = room.players.find(p => p.userId === userId);
        
        if (p) {
            p.id = socket.id;
            p.online = true;

            // 2. Recupera e cancella il timer dalla mappa esterna
                if (disconnectTimers[userId]) {
                    clearTimeout(disconnectTimers[userId]);
                    delete disconnectTimers[userId];
                }
            
            socket.join(roomId);
            io.to(roomId).emit('playerBack', { userId: p.userId, newSocketId: socket.id });

            // Crea una copia della stanza senza dati circolari se necessario
            socket.emit('reSyncGame', { 
                room, 
                hand: p.hand,
                myId: socket.id 
            });
            break;
        }
    }
});
    
    socket.on('createRoom', (data) => {
        leaveOldRooms(socket.userId, socket);
        
        const roomId = Math.random().toString(36).substring(2, 7);
        rooms[roomId] = {
            id: roomId,
            creator: data.playerName,
            creatorUserId: socket.userId,
            maxPlayers: data.maxPlayers,
            players: [{ 
                id: socket.id, 
                userId: socket.userId, // ID persistente
                name: data.playerName, 
                points: 0, tricksWon: 0, bet: null, ready: false 
            }],
            status: 'waiting',
            currentRound: 1,
            currentTrick: [],
            turnIndex: 0,
            tricksInRound: 0,
            roundStarterIndex: 0 
        };
        socket.join(roomId);
        socket.emit('roomCreated', rooms[roomId]);
        io.emit('updateRoomList', Object.values(rooms).filter(r => r.status === 'waiting'));
    });

    socket.on('joinRoom', (data) => {
        leaveOldRooms(socket.userId, socket);
        const room = rooms[data.roomId];
        if (room && room.players.length < room.maxPlayers) {
            room.players.push({ 
                id: socket.id, 
                userId: socket.userId,
                name: data.playerName, 
                points: 0, tricksWon: 0, bet: null, ready: false 
            });
            socket.join(data.roomId);
            if (room.players.length == room.maxPlayers) {
                room.status = 'playing';
                io.to(room.id).emit('startGame', room);
                startNewRound(room);
            }
            io.emit('updateRoomList', Object.values(rooms).filter(r => r.status === 'waiting'));
        }
    });

    socket.on('placeBet', ({ roomId, bet }) => {
        const room = rooms[roomId];
        if (!room) return;

        // ✅ Controllo su userId
        if (room.players[room.turnIndex].userId !== socket.userId) return;

        const player = room.players.find(p => p.userId === socket.userId);
        if (player) player.bet = bet;

        io.to(roomId).emit('playerBetPlaced', { 
            playerId: socket.id, // ID per animazioni frontend
            bet: bet 
        });

        if (room.players.every(p => p.bet !== null)) {
            room.turnIndex = room.roundStarterIndex;
            io.to(roomId).emit('betsConfirmed', room.players);
            io.to(room.players[room.turnIndex].id).emit('yourTurn');
        } else {
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
            io.to(room.players[room.turnIndex].id).emit('betTurn', { message: "Tocca a te scommettere!" });
        }
    });

   socket.on('playCard', ({ roomId, card }) => {
    const room = rooms[roomId];
    if (!room) return;
    
    const currentPlayer = room.players[room.turnIndex];
    if (currentPlayer.userId !== socket.userId) return;

    // ✅ TROVA E SEGNA LA CARTA COME GIOCATA SUL SERVER
    const cardInServerHand = currentPlayer.hand.find(c => 
        c.suit === card.suit && c.name === card.name && !c.played
    );

    if (cardInServerHand) {
        cardInServerHand.played = true; // La carta è ora "consumata" sul server
    }

    room.currentTrick.push({ owner: socket.id, userId: socket.userId, card });
    io.to(roomId).emit('cardPlayed', { 
    owner: socket.id, 
    userId: socket.userId, 
    card 
});

    if (room.currentTrick.length === room.players.length) {
        resolveTrick(room);
    } else {
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
        io.to(room.players[room.turnIndex].id).emit('yourTurn');
    }
});

    socket.on('readyForNextRound', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.userId === socket.userId);
    if (player) player.ready = true; // Segna come pronto

    // Se tutti sono pronti, startNewRound
    if (room.players.every(p => p.ready)) {
        room.currentRound++;
        room.players.forEach(p => p.ready = false); // Reset per prossimo round
        startNewRound(room);
    }
});

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const p = room.players.find(p => p.userId === socket.userId);
            if (p) {
                p.online = false;
                io.to(roomId).emit('playerAway', { userId: p.userId, timeout: 60 });

                // 3. Salva il timer nella mappa esterna usando userId come chiave
                disconnectTimers[p.userId] = setTimeout(() => {
                    if (!p.online) {
                        io.to(roomId).emit('playerDisconnected', { name: p.name });
                        delete rooms[roomId];
                        delete disconnectTimers[p.userId]; // Pulizia
                    }
                }, 60000); 
                break;
            }
        }
    });
});

function leaveOldRooms(userId, socket) {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        const playerIndex = room.players.findIndex(p => p.userId === userId);

        if (playerIndex !== -1) {
            // Se era l'unico o il creatore, distruggiamo la stanza
            // Altrimenti lo rimuoviamo semplicemente
            if (room.players.length <= 1 || room.creatorUserId === userId) {
                io.to(roomId).emit('playerDisconnected', { name: room.players[playerIndex].name });
                delete rooms[roomId];
            } else {
                room.players.splice(playerIndex, 1);
                io.to(roomId).emit('updateRoomData', room); // Notifica agli altri
            }
            socket.leave(roomId); // Esce dal canale Socket.io
        }
    }
}

function startNewRound(room) {
    const deck = createDeck();
    room.currentTrick = [];
    room.tricksInRound = 0;
    
    // Gestione Turni
    if (room.currentRound === 1) {
        room.roundStarterIndex = Math.floor(Math.random() * room.players.length);
    } else {
        room.roundStarterIndex = (room.roundStarterIndex + 1) % room.players.length;
    }
    room.turnIndex = room.roundStarterIndex;

    // Distribuzione con inizializzazione stato
    room.players.forEach((p) => { 
        const rawHand = deck.splice(0, room.currentRound);
        p.hand = rawHand.map(card => ({ ...card, played: false })); 
        p.bet = null; // ✅ CRITICO: Resetta la scommessa a null ogni round
        p.tricksWon = 0; // ✅ CRITICO: Resetta le prese ogni round
    });
    
    room.players.forEach(p => {
        const opponentsData = room.players.map(opp => ({
            id: opp.id,
            userId: opp.userId, // Importante per il frontend
            name: opp.name,
            points: opp.points,
            tricksWon: opp.tricksWon,
            bet: opp.bet,
            // Al round 1 le carte sono visibili, altrimenti nulle
            hand: (room.currentRound === 1) ? opp.hand : null 
        }));

        io.to(p.id).emit('yourHand', { 
            hand: p.hand, 
            round: room.currentRound,
            opponents: opponentsData 
        });
    });

    io.to(room.id).emit('newRoundStarted', { 
        round: room.currentRound, 
        starterId: room.players[room.turnIndex].id 
    });

    io.to(room.players[room.turnIndex].id).emit('betTurn');
}

function resolveTrick(room) {
    let winnerObj = room.currentTrick[0];
    for (let i = 1; i < room.currentTrick.length; i++) {
        const cur = room.currentTrick[i];
        if (cur.card.power > winnerObj.card.power || (cur.card.power === winnerObj.card.power && suitOrder[cur.card.suit] > suitOrder[winnerObj.card.suit])) {
            winnerObj = cur;
        }
    }
    
    // ✅ Cerca per userId (più robusto)
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
    }, 2000);
}

function endRound(room) {
    room.players.forEach(p => {
        const gained = (p.tricksWon === p.bet) ? (10 + p.bet) : -Math.abs(p.bet - p.tricksWon);
        p.points += gained;
    });

    // Se abbiamo finito il round 10
    if (room.currentRound === 10) {
    // eliminiamo la stanza dopo un po' per liberare memoria
        setTimeout(() => {
            delete rooms[room.id];
        }, 1000);
    } else {
        io.to(room.id).emit('roundEnded', { 
            players: room.players, 
            nextRound: room.currentRound + 1 
        });
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server pronto sulla porta ${PORT}`));

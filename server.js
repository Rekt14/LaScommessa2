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

io.on('connection', (socket) => {

     socket.on('handshake', (userId) => {
        // Salviamo l'ID sul socket immediatamente
        socket.userId = userId;       
        // Verifica riconnessione
        for (const roomId in rooms) {
            const room = rooms[roomId];
            // Ora p.userId esisterà perché lo salviamo in join/create
            const p = room.players.find(p => p.userId === userId);            
            if (p) {
                p.id = socket.id; // Aggiorna socket ID
                p.online = true;
                clearTimeout(p.disconnectTimer); // Ferma il countdown
                socket.join(roomId);                
                console.log(`Utente ${p.name} riconnesso con successo.`);
                io.to(roomId).emit('playerBack', { userId: p.userId, newSocketId: socket.id });
                // Invia lo stato attuale
                socket.emit('reSyncGame', { 
                    room, 
                    hand: p.hand,
                    // Aggiungiamo info utili per il frontend
                    myId: socket.id 
                });
                break;
            }
        }
    });
    
    // CREAZIONE STANZA
    // NEL BACKEND
socket.on('createRoom', (data) => {
    // Se l'handshake non è ancora arrivato, usiamo il nome o un fallback
    const userId = socket.userId || `temp_${Math.random()}`; 
    
    const roomId = Math.random().toString(36).substring(2, 7);
    rooms[roomId] = {
        id: roomId,
        creator: data.playerName,
        creatorUserId: userId, 
        maxPlayers: data.maxPlayers,
        players: [{ 
            id: socket.id, 
            userId: userId,
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

    // Aggiorna lista stanze
socket.on('requestUpdateRooms', () => {
    socket.emit('updateRoomList', Object.values(rooms).filter(r => r.status === 'waiting'));
});

    // ACCESSO STANZA
    socket.on('joinRoom', (data) => {
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

    // SCOMMESSA
// SCOMMESSA SEQUENZIALE
    socket.on('placeBet', ({ roomId, bet }) => {
        const room = rooms[roomId];
        if (!room) return;

        // Verifica che sia effettivamente il turno di questo giocatore per scommettere
        if (room.players[room.turnIndex].id !== socket.id) {
            return; // Ignora se prova a scommettere fuori turno
        }

        const player = room.players.find(p => p.id === socket.id);
        if (player) player.bet = bet;

        // 1. Notifica a TUTTI che questo giocatore ha scommesso (così vedono il numero)
        io.to(roomId).emit('playerBetPlaced', { 
            playerId: socket.id, 
            bet: bet 
        });

        // 2. Controlliamo se tutti hanno scommesso
        const allHaveBet = room.players.every(p => p.bet !== null && p.bet !== undefined);

        if (allHaveBet) {
            // A. TUTTI HANNO SCOMMESSO -> INIZIA LA PARTITA
            
            // IMPORTANTE: Resettiamo il turnIndex a chi ha iniziato il round (roundStarterIndex)
            // Perché chi inizia a scommettere deve anche giocare la prima carta.
            room.turnIndex = room.roundStarterIndex;

            io.to(roomId).emit('betsConfirmed', room.players);
            
            // Diamo il turno di gioco al primo giocatore
            io.to(room.players[room.turnIndex].id).emit('yourTurn');

        } else {
            // B. MANCA QUALCUNO -> PASSA AL PROSSIMO PER SCOMMETTERE
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
            
            // Notifica al prossimo che tocca a lui scommettere
            io.to(room.players[room.turnIndex].id).emit('betTurn', { message: "Tocca a te scommettere!" });
        }
    });

    // GIOCATA CARTA
    socket.on('playCard', ({ roomId, card }) => {
        const room = rooms[roomId];
        if (!room || room.players[room.turnIndex].id !== socket.id) return;

        room.currentTrick.push({ owner: socket.id, card });
        io.to(roomId).emit('cardPlayed', { owner: socket.id, card });

        if (room.currentTrick.length === room.players.length) {
            resolveTrick(room);
        } else {
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
            io.to(room.players[room.turnIndex].id).emit('yourTurn');
        }
    });

    // PRONTO PER PROSSIMO ROUND
    socket.on('readyForNextRound', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) player.ready = true;

        if (room.players.every(p => p.ready)) {
            room.currentRound++;
            room.players.forEach(p => { p.ready = false; p.bet = null; p.tricksWon = 0; });
            startNewRound(room);
        }
    });

   // DISCONNESSIONE CON GRACE PERIOD
     socket.on('disconnect', () => {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        const p = room.players.find(p => p.id === socket.id);
        if (p) {
            p.online = false;
            // Avvisa gli altri che parte il countdown di 60s
            io.to(roomId).emit('playerAway', { userId: p.userId, timeout: 60 });
            p.disconnectTimer = setTimeout(() => {
                if (!p.online) {
                    io.to(roomId).emit('playerDisconnected', { name: p.name });
                    delete rooms[roomId];
                    io.emit('updateRoomList', Object.values(rooms).filter(r => r.status === 'waiting'));
                }
            }, 60000); 
            break;
            }
        }
    });
});

function startNewRound(room) {
    // 1. Gestione Mazzo
    const deck = createDeck();
    
    // 2. Reset Variabili di gioco
    room.currentTrick = [];
    room.tricksInRound = 0;
    
    // 3. Gestione chi inizia (Rotazione o Random)
    if (room.currentRound === 1) {
        // Round 1: Scegliamo un giocatore a caso che inizierà a scommettere e giocare
        room.roundStarterIndex = Math.floor(Math.random() * room.players.length);
    } else {
        // Round > 1: Il turno passa al giocatore successivo rispetto a chi ha iniziato il round precedente
        room.roundStarterIndex = (room.roundStarterIndex + 1) % room.players.length;
    }

    // Impostiamo il turno attuale a chi deve iniziare (per la fase scommesse)
    room.turnIndex = room.roundStarterIndex;

    // 4. Distribuzione carte (Logica esistente)
    // Distribuisce un numero di carte pari al round corrente
    const cardsNeeded = room.players.length * room.currentRound;
    
    // Controllo sicurezza mazzo (opzionale ma consigliato)
    if (deck.length < cardsNeeded) {
        console.error("ERRORE: Non ci sono abbastanza carte nel mazzo!");
        return; 
    }

    room.players.forEach((p, index) => { 
        // Nota: Assicurati che deck.splice funzioni correttamente (l'hai definita fuori)
        p.hand = deck.splice(0, room.currentRound); 
    });

    // 5. Invio dati ai client
    room.players.forEach(p => {
        const opponentsData = room.players.map(opp => ({
            id: opp.id,
            name: opp.name,
            points: opp.points,
            tricksWon: opp.tricksWon,
            bet: opp.bet,
            // Al round 1 mostriamo le carte di tutti (se vuoi mantenere questa regola), altrimenti nascondi
            hand: (room.currentRound === 1) ? opp.hand : null 
        }));

        io.to(p.id).emit('yourHand', { 
            hand: p.hand, 
            round: room.currentRound,
            opponents: opponentsData 
        });
    });

    // 6. AVVIO FASE SCOMMESSE
    // Diciamo a tutti di aggiornare l'HUD (per pulire vecchie scommesse)
    io.to(room.id).emit('newRoundStarted', { 
        round: room.currentRound, 
        starterId: room.players[room.turnIndex].id 
    });

    // Diciamo SOLO al giocatore di turno che tocca a lui scommettere
    io.to(room.players[room.turnIndex].id).emit('betTurn', { message: "Tocca a te scommettere!" });
}

function resolveTrick(room) {
    let winner = room.currentTrick[0];
    for (let i = 1; i < room.currentTrick.length; i++) {
        const cur = room.currentTrick[i];
        if (cur.card.power > winner.card.power || (cur.card.power === winner.card.power && suitOrder[cur.card.suit] > suitOrder[winner.card.suit])) {
            winner = cur;
        }
    }
    
    const winningPlayer = room.players.find(p => p.id === winner.owner);
    winningPlayer.tricksWon++;
    room.turnIndex = room.players.findIndex(p => p.id === winner.owner);
    room.tricksInRound++;

    setTimeout(() => {
        io.to(room.id).emit('trickResolved', { winnerId: winner.owner, players: room.players });
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
    io.to(room.id).emit('roundEnded', { players: room.players, nextRound: room.currentRound + 1 });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server pronto sulla porta ${PORT}`));

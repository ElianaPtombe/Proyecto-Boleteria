// Dependencias necesarias: npm install express crypto-js cors
const express = require('express');
const CryptoJS = require('crypto-js');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());

// ==========================================
// ADMINISTRADORES
// ==========================================
const ADMIN_EMAILS = ['admin@ticketchain.com'];

function esAdmin(email) {
    if (!email) return false;
    return ADMIN_EMAILS.map(e => e.toLowerCase().trim()).includes(email.toLowerCase().trim());
}

// ==========================================
// PERSISTENCIA DE USUARIOS (users.json)
// ==========================================
const USERS_FILE = './users.json';

const DEFAULT_ADMIN = {
    name: 'Administrador TicketChain',
    email: 'admin@ticketchain.com',
    pass: 'admin123',
    bio: 'admin_bio_verification'
};

function loadUsers() {
    let users = [];

    if (fs.existsSync(USERS_FILE)) {
        try {
            const data = fs.readFileSync(USERS_FILE, 'utf-8');
            users = JSON.parse(data);
        } catch (e) {
            users = [];
        }
    }

    const adminExiste = users.some(u => u.email === DEFAULT_ADMIN.email);

    if (!adminExiste) {
        users.push(DEFAULT_ADMIN);
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        console.log(`[INIT] Usuario admin precargado exitosamente: ${DEFAULT_ADMIN.email}`);
    }

    return users;
}

function saveUser(user) {
    const list = loadUsers();
    list.push(user);
    fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2));
}

// ==========================================
// ARQUITECTURA BLOCKCHAIN
// ==========================================
class Block {
    constructor(index, data, previousHash = '') {
        this.index = index;
        this.date = new Date().toISOString();
        this.data = data;
        this.previousHash = previousHash;
        this.nonce = 0;
        this.hash = this.createHash();
    }

    createHash() {
        return CryptoJS.SHA256(
            this.index + this.date + JSON.stringify(this.data) + this.previousHash + this.nonce
        ).toString();
    }

    mine(difficulty) {
        while (!this.hash.startsWith(difficulty)) {
            this.nonce++;
            this.hash = this.createHash();
        }
    }
}

class BlockChain {
    constructor(genesis, difficulty = '00') {
        this.chain = [this.createFirstBlock(genesis)];
        this.difficulty = difficulty;
    }

    createFirstBlock(genesis) {
        return new Block(0, { type: 'GENESIS', info: genesis });
    }

    getLastBlock() {
        return this.chain[this.chain.length - 1];
    }

    addBlock(data) {
        const prevBlock = this.getLastBlock();
        const block = new Block(prevBlock.index + 1, data, prevBlock.hash);
        block.mine(this.difficulty);
        this.chain.push(block);
        return block;
    }

    isValid() {
        for (let i = 1; i < this.chain.length; i++) {
            const current = this.chain[i];
            const previous = this.chain[i - 1];

            if (current.hash !== current.createHash()) return { ok: false, index: i };
            if (current.previousHash !== previous.hash) return { ok: false, index: i };
        }
        return { ok: true };
    }
}

// INSTANCIA BASE DE DATOS Y CADENA
const ticketChain = new BlockChain('Genesis TicketChain Base', '00');

const eventos = [
    { id: 101, nombre: "Concierto Rock Fest 2026", fecha: "2026-10-15", lugar: "Estadio Central", precio: 200000 },
    { id: 102, nombre: "Conferencia Blockchain", fecha: "2026-11-20", lugar: "Centro Eventos", precio: 100000 },
    { id: 103, nombre: "Feria de Tecnología", fecha: "2026-12-05", lugar: "Parque Expo", precio: 50000 },
    { id: 104, nombre: "Festival de Jazz", fecha: "2026-09-10", lugar: "Teatro Nacional", precio: 150000 },
    { id: 105, nombre: "Maratón Ciudad 2026", fecha: "2026-08-25", lugar: "Avenida Principal", precio: 30000 },
    { id: 106, nombre: "Exposición de Arte Moderno", fecha: "2026-07-18", lugar: "Galería de Arte", precio: 80000 },
    { id: 107, nombre: "Torneo de Videojuegos", fecha: "2026-11-05", lugar: "Arena Gaming", precio: 120000 },
    { id: 108, nombre: "Festival de Cine Internacional", fecha: "2026-10-30", lugar: "Cinepolis Plaza", precio: 90000 },
    { id: 109, nombre: "Conferencia de Inteligencia Artificial", fecha: "2026-12-15", lugar: "Centro de Convenciones", precio: 110000 },
    { id: 110, nombre: "Feria Gastronómica", fecha: "2026-09-20", lugar: "Parque Central", precio: 40000 }
];

// Helper para obtener el estado actual acumulado de cada ticket
function getTicketsState() {
    const ticketsMap = {};
    ticketChain.chain.forEach((block, index) => {
        if (block.data && block.data.ticketId) {
            ticketsMap[block.data.ticketId] = { 
                ...block.data, 
                lastHash: block.hash, 
                blockIndex: index 
            };
        }
    });
    return Object.values(ticketsMap);
}

// ==========================================
// RUTAS API (ENDPOINTS)
// ==========================================

// Autenticación
app.post('/api/register', (req, res) => {
    const { name, email, pass, bio } = req.body;
    if (!email || !pass) return res.status(400).json({ error: 'Datos incompletos' });

    const emailNormalizado = email.toLowerCase().trim();
    const usuarios = loadUsers();
    if (usuarios.find(u => u.email === emailNormalizado)) {
        return res.status(400).json({ error: 'El usuario ya existe' });
    }

    saveUser({ name, email: emailNormalizado, pass, bio });
    res.json({ success: true, message: 'Usuario registrado exitosamente' });
});

app.post('/api/login', (req, res) => {
    const { email, pass } = req.body;
    const emailNormalizado = (email || '').toLowerCase().trim();
    const usuarios = loadUsers();
    const user = usuarios.find(u => u.email === emailNormalizado && u.pass === pass);
    if (user) {
        res.json({ success: true, user: { name: user.name, email: user.email, isAdmin: esAdmin(user.email) } });
    } else {
        res.status(401).json({ error: 'Credenciales inválidas' });
    }
});

// Lectura de Estado y Eventos
app.get('/api/eventos', (req, res) => res.json(eventos));

app.get('/api/chain-status', (req, res) => {
    res.json({
        integrity: ticketChain.isValid(),
        chain: ticketChain.chain,
        tickets: getTicketsState()
    });
});

// Operaciones con Entradas
app.post('/api/tickets/buy', (req, res) => {
    const { eventoId, email } = req.body;
    const evento = eventos.find(e => e.id === eventoId);
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });

    const ticketData = {
        type: 'TICKET_MINT',
        ticketId: 'TKT-' + Math.floor(Math.random() * 899999 + 100000),
        evento: evento.nombre,
        precio: evento.precio,
        propietario: (email || '').toLowerCase().trim(),
        estado: 'VALIDO',
        enVenta: false
    };

    const block = ticketChain.addBlock(ticketData);
    res.json({ success: true, ticket: ticketData, hash: block.hash });
});

app.post('/api/tickets/resell', (req, res) => {
    const { ticketId, precio, propietario } = req.body;
    const ownerEmail = (propietario || '').toLowerCase().trim();
    const tickets = getTicketsState();
    const ticket = tickets.find(t => t.ticketId === ticketId);

    if (!ticket || ticket.propietario !== ownerEmail) {
        return res.status(403).json({ error: 'No tienes permiso sobre esta entrada' });
    }

    const precioNumerico = parseFloat(precio);
    const RECARGO_MAXIMO_COP = 10000;
    const precioMaximo = ticket.precio + RECARGO_MAXIMO_COP;

    if (isNaN(precioNumerico) || precioNumerico <= 0) {
        return res.status(400).json({ error: 'Precio inválido' });
    }

    if (precioNumerico > precioMaximo) {
        return res.status(400).json({
            error: `El precio de reventa no puede superar $${precioMaximo.toLocaleString('es-CO')} COP`
        });
    }

    const resellData = {
        ...ticket,
        type: 'TICKET_RESALE_LIST',
        precio: precioNumerico,
        enVenta: true
    };

    ticketChain.addBlock(resellData);
    res.json({ success: true, message: 'Entrada listada en el Marketplace' });
});

app.post('/api/tickets/buy-resell', (req, res) => {
    const { ticketId, comprador } = req.body;
    const buyerEmail = (comprador || '').toLowerCase().trim();
    const tickets = getTicketsState();
    const ticket = tickets.find(t => t.ticketId === ticketId);

    if (!ticket || !ticket.enVenta) {
        return res.status(400).json({ error: 'El ticket no está disponible para reventa' });
    }

    if (ticket.propietario === buyerEmail) {
        return res.status(400).json({ error: 'No puedes comprar tu propia entrada' });
    }

    const buyData = {
        ...ticket,
        type: 'TICKET_RESALE_BUY',
        propietario: buyerEmail,
        enVenta: false
    };

    ticketChain.addBlock(buyData);
    res.json({ success: true, message: '¡Entrada comprada en el Marketplace con éxito!' });
});

app.post('/api/tickets/transfer', (req, res) => {
    const { ticketId, nuevoPropietario, remitente } = req.body;
    const senderEmail = (remitente || '').toLowerCase().trim();
    const newOwnerEmail = (nuevoPropietario || '').toLowerCase().trim();

    const tickets = getTicketsState();
    const ticket = tickets.find(t => t.ticketId === ticketId);

    if (!ticket || ticket.propietario !== senderEmail) {
        return res.status(403).json({ error: 'No eres el propietario legítimo' });
    }

    const transferData = {
        ...ticket,
        type: 'TICKET_TRANSFER',
        propietario: newOwnerEmail,
        enVenta: false
    };

    ticketChain.addBlock(transferData);
    res.json({ success: true, message: 'Transferencia realizada con éxito' });
});

// Validación en Puerta (SOLO ADMINISTRADOR)
app.post('/api/tickets/validate', (req, res) => {
    const { hash: codigo, email, bio, adminEmail } = req.body;

    const adminEmailNormalizado = (adminEmail || '').toLowerCase().trim();
    const usuarios = loadUsers();
    
    // Validar rol y existencia del admin en la persistencia
    const adminExiste = usuarios.some(u => u.email === adminEmailNormalizado);
    if (!esAdmin(adminEmailNormalizado) || !adminExiste) {
        return res.status(403).json({ 
            access: false, 
            message: '✗ ACCESO RESTRINGIDO: No tienes permisos de administrador para validar entradas' 
        });
    }

    const tickets = getTicketsState();
    const ticket = tickets.find(t => t.ticketId === codigo || t.lastHash === codigo);
    const emailNormalizado = (email || '').toLowerCase().trim();
    const user = usuarios.find(u => u.email === emailNormalizado);

    if (!ticket) {
        return res.status(404).json({ access: false, message: '✗ DENEGAR ACCESO: Ticket inexistente' });
    }
    if (ticket.estado === 'USADO') {
        return res.status(400).json({ access: false, message: '✗ DENEGAR ACCESO: El ticket ya fue utilizado' });
    }
    if (ticket.propietario !== emailNormalizado) {
        return res.status(403).json({ access: false, message: '✗ DENEGAR ACCESO: Propietario no coincide en Blockchain' });
    }
    if (!user || user.bio !== bio) {
        return res.status(401).json({ access: false, message: '✗ DENEGAR ACCESO: Verificación biométrica/facial fallida' });
    }

    ticketChain.addBlock({
        ...ticket,
        type: 'TICKET_USED',
        estado: 'USADO',
        enVenta: false
    });

    res.json({ access: true, message: '✓ ACCESO PERMITIDO: Entrada validada correctamente' });
});

// Inicialización del servidor y precarga del admin
loadUsers();

const PORT = 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
app.use(cors());
app.use(express.json());

// --- INICIALIZACIÓN DE LA BASE DE DATOS ---
const db = new Database('database.db');

// Crear tablas si no existen
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    pass TEXT NOT NULL,
    bio TEXT,
    isAdmin INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    fecha TEXT NOT NULL,
    lugar TEXT NOT NULL,
    precio REAL NOT NULL,
    aforo INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS blockchain (
    idx INTEGER PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    transactions TEXT NOT NULL,
    previousHash TEXT NOT NULL,
    nonce INTEGER NOT NULL,
    hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tickets (
    ticketId TEXT PRIMARY KEY,
    eventoId INTEGER NOT NULL,
    evento TEXT NOT NULL,
    propietario TEXT NOT NULL,
    precio REAL NOT NULL,
    estado TEXT NOT NULL,
    enVenta INTEGER DEFAULT 0
  );
`);

// Insertar evento inicial por defecto si la tabla está vacía
const totalEventos = db.prepare('SELECT COUNT(*) as count FROM eventos').get();
if (totalEventos.count === 0) {
  db.prepare(`
    INSERT INTO eventos (nombre, fecha, lugar, precio, aforo) 
    VALUES ('Concierto Rock Fest', '20 Oct, 2026', 'Estadio El Campín', 150000, 500)
  `).run();
}

// --- ESTRUCTURA DE BLOCKCHAIN CON PERSISTENCIA ---
class Block {
  constructor(index, timestamp, transactions, previousHash = '', nonce = 0, hash = '') {
    this.index = index;
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.previousHash = previousHash;
    this.nonce = nonce;
    this.hash = hash || this.calculateHash();
  }

  calculateHash() {
    return crypto
      .createHash('sha256')
      .update(this.index + this.previousHash + this.timestamp + JSON.stringify(this.transactions) + this.nonce)
      .digest('hex');
  }

  mineBlock(difficulty) {
    while (this.hash.substring(0, difficulty) !== Array(difficulty + 1).join("0")) {
      this.nonce++;
      this.hash = this.calculateHash();
    }
  }
}

class PersistentBlockchain {
  constructor() {
    this.difficulty = 2;
    this.initGenesisBlock();
  }

  initGenesisBlock() {
    const genesis = db.prepare('SELECT * FROM blockchain WHERE idx = 0').get();
    if (!genesis) {
      const genesisBlock = new Block(0, Date.now(), [{ info: "Génesis TicketChain" }], "0");
      genesisBlock.mineBlock(this.difficulty);
      this.saveBlock(genesisBlock);
    }
  }

  getLatestBlock() {
    const row = db.prepare('SELECT * FROM blockchain ORDER BY idx DESC LIMIT 1').get();
    return new Block(row.idx, row.timestamp, JSON.parse(row.transactions), row.previousHash, row.nonce, row.hash);
  }

  saveBlock(block) {
    db.prepare(`
      INSERT INTO blockchain (idx, timestamp, transactions, previousHash, nonce, hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(block.index, block.timestamp, JSON.stringify(block.transactions), block.previousHash, block.nonce, block.hash);
  }

  addBlock(transactions) {
    const latestBlock = this.getLatestBlock();
    const newBlock = new Block(latestBlock.index + 1, Date.now(), transactions, latestBlock.hash);
    newBlock.mineBlock(this.difficulty);
    this.saveBlock(newBlock);
  }

  getChain() {
    const rows = db.prepare('SELECT * FROM blockchain ORDER BY idx ASC').all();
    return rows.map(r => ({
      index: r.idx,
      timestamp: r.timestamp,
      transactions: JSON.parse(r.transactions),
      previousHash: r.previousHash,
      nonce: r.nonce,
      hash: r.hash
    }));
  }

  isChainValid() {
    const chain = this.getChain();
    for (let i = 1; i < chain.length; i++) {
      const current = new Block(chain[i].index, chain[i].timestamp, chain[i].transactions, chain[i].previousHash, chain[i].nonce, chain[i].hash);
      const previous = chain[i - 1];

      if (current.hash !== current.calculateHash()) return false;
      if (current.previousHash !== previous.hash) return false;
    }
    return true;
  }
}

const chainInstance = new PersistentBlockchain();

// --- RUTAS API ---

// 1. Registro de usuario (persistente)
app.post('/api/register', (req, res) => {
  const { name, email, pass, bio } = req.body;

  const existingUser = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existingUser) {
    return res.status(400).json({ error: 'El usuario ya está registrado' });
  }

  const isAdmin = email.toLowerCase().includes('admin') ? 1 : 0;
  
  db.prepare(`
    INSERT INTO users (name, email, pass, bio, isAdmin) 
    VALUES (?, ?, ?, ?, ?)
  `).run(name, email, pass, bio || 'bio_default', isAdmin);

  res.json({ message: 'Usuario registrado correctamente' });
});

// 2. Inicio de sesión (persistente)
app.post('/api/login', (req, res) => {
  const { email, pass } = req.body;
  const user = db.prepare('SELECT id, name, email, bio, isAdmin FROM users WHERE email = ? AND pass = ?').get(email, pass);

  if (!user) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }

  res.json({ 
    user: {
      ...user,
      isAdmin: Boolean(user.isAdmin)
    } 
  });
});

// 3. Obtener eventos
app.get('/api/eventos', (req, res) => {
  const eventos = db.prepare('SELECT * FROM eventos').all();
  res.json(eventos);
});

// 4. Crear evento
app.post('/api/eventos', (req, res) => {
  const { nombre, fecha, lugar, precio, aforo, adminEmail } = req.body;

  if (!nombre || !fecha || !lugar || precio === undefined || !aforo) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }

  const info = db.prepare(`
    INSERT INTO eventos (nombre, fecha, lugar, precio, aforo) 
    VALUES (?, ?, ?, ?, ?)
  `).run(nombre, fecha, lugar, parseFloat(precio), parseInt(aforo));

  const nuevoEvento = { id: info.lastInsertRowid, nombre, fecha, lugar, precio: parseFloat(precio), aforo: parseInt(aforo) };
  

  chainInstance.addBlock([{
    tipo: 'CREACION_EVENTO',
    eventoId: nuevoEvento.id,
    nombre: nuevoEvento.nombre,
    creadoPor: adminEmail || 'Admin'
  }]);

  res.json({ message: 'Evento creado con éxito', evento: nuevoEvento });
});

// 5. Comprar Ticket
app.post('/api/tickets/buy', (req, res) => {
  const { eventoId, email } = req.body;
  const evento = db.prepare('SELECT * FROM eventos WHERE id = ?').get(eventoId);

  if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });

  const ticketId = 'TICK-' + crypto.randomBytes(4).toString('hex').toUpperCase();

  db.prepare(`
    INSERT INTO tickets (ticketId, eventoId, evento, propietario, precio, estado, enVenta)
    VALUES (?, ?, ?, ?, ?, 'VALIDO', 0)
  `).run(ticketId, eventoId, evento.nombre, email, evento.precio);

  chainInstance.addBlock([{ tipo: 'COMPRA_DIRECTA', ticketId, comprador: email, evento: evento.nombre }]);

  res.json({ message: 'Ticket comprado con éxito', ticketId });
});

// 6. Revender Ticket
app.post('/api/tickets/resell', (req, res) => {
  const { ticketId, precio, propietario } = req.body;
  const ticket = db.prepare('SELECT * FROM tickets WHERE ticketId = ? AND propietario = ?').get(ticketId, propietario);

  if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado o no te pertenece' });

  db.prepare('UPDATE tickets SET enVenta = 1, precio = ? WHERE ticketId = ?').run(parseFloat(precio), ticketId);

  chainInstance.addBlock([{ tipo: 'PUBLICAR_REVENTA', ticketId, nuevoPrecio: precio, vendedor: propietario }]);
  res.json({ message: 'Ticket puesto en reventa' });
});

// 7. Comprar Reventa
app.post('/api/tickets/buy-resell', (req, res) => {
  const { ticketId, comprador } = req.body;
  const ticket = db.prepare('SELECT * FROM tickets WHERE ticketId = ? AND enVenta = 1').get(ticketId);

  if (!ticket) return res.status(404).json({ error: 'Ticket no disponible para reventa' });

  db.prepare('UPDATE tickets SET propietario = ?, enVenta = 0 WHERE ticketId = ?').run(comprador, ticketId);

  chainInstance.addBlock([{ tipo: 'COMPRA_REVENTA', ticketId, de: ticket.propietario, para: comprador, precio: ticket.precio }]);
  res.json({ message: 'Reventa completada con éxito' });
});

// 8. Transferir Ticket
app.post('/api/tickets/transfer', (req, res) => {
  const { ticketId, nuevoPropietario, remitente } = req.body;
  const ticket = db.prepare('SELECT * FROM tickets WHERE ticketId = ? AND propietario = ?').get(ticketId, remitente);

  if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });

  db.prepare('UPDATE tickets SET propietario = ? WHERE ticketId = ?').run(nuevoPropietario, ticketId);

  chainInstance.addBlock([{ tipo: 'TRANSFERENCIA', ticketId, de: remitente, para: nuevoPropietario }]);
  res.json({ message: 'Ticket transferido correctamente' });
});

// 9. Validar Ticket en Puerta
app.post('/api/tickets/validate', (req, res) => {
  const { hash, email } = req.body;
  const ticket = db.prepare('SELECT * FROM tickets WHERE ticketId = ?').get(hash);

  if (!ticket) return res.status(404).json({ access: false, message: 'Entrada inválida o no existente' });
  if (ticket.propietario !== email) return res.status(403).json({ access: false, message: 'La entrada no pertenece a este correo' });
  if (ticket.estado === 'USADO') return res.status(400).json({ access: false, message: 'Esta entrada ya fue utilizada' });

  db.prepare("UPDATE tickets SET estado = 'USADO' WHERE ticketId = ?").run(hash);

  chainInstance.addBlock([{ tipo: 'INGRESO_EVENTO', ticketId: hash, asistente: email, fecha: new Date().toISOString() }]);
  res.json({ access: true, message: 'Acceso concedido. Entrada válida.' });
});

// 10. Estado Blockchain y Tickets
app.get('/api/chain-status', (req, res) => {
  const chain = chainInstance.getChain();
  const tickets = db.prepare('SELECT * FROM tickets').all().map(t => ({ ...t, enVenta: Boolean(t.enVenta) }));

  res.json({
    length: chain.length,
    valid: chainInstance.isChainValid(),
    chain,
    tickets
  });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT} (Datos guardados en database.db)`);
});
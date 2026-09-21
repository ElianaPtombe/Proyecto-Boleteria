'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// =====================================================
// 1. CONFIGURACIÓN
// =====================================================

const CONFIG = {
  PORT: 3000,
  DB_FILE: 'database.db',

  // Comprador A puede publicar una entrada en reventa
  // hasta un recargo máximo de $10.000 COP sobre el precio original.
  MAX_RESALE_EXTRA: 10000,

  // Dificultad de minado (cantidad de ceros iniciales del hash)
  BLOCKCHAIN_DIFFICULTY: 2,

  // Máximo de cortesías por solicitud
  MAX_COURTESY_QTY: 100,

  // Evento de ejemplo que se crea si la base está vacía
  SEED_EVENT: {
    nombre: 'Concierto Rock Fest',
    fecha: '20 Oct, 2026',
    lugar: 'Estadio El Campín',
    precio: 150000,
    aforo: 500
  }
};

const TICKET_STATE = {
  VALID: 'VALIDO',
  USED: 'USADO'
};


// =====================================================
// 2. BASE DE DATOS (conexión, esquema, migración, seed)
// =====================================================

const db = new Database(CONFIG.DB_FILE);

db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

function createSchema() {
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
      precioOriginal REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL,
      enVenta INTEGER DEFAULT 0
    );
  `);
}

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = columns.some(c => c.name === column);

  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Migración para bases de datos antiguas
function migrateSchema() {
  addColumnIfMissing('tickets', 'precioOriginal', 'REAL NOT NULL DEFAULT 0');

  db.prepare(`
    UPDATE tickets
    SET precioOriginal = precio
    WHERE precioOriginal = 0
    AND precio > 0
  `).run();
}

function seedInitialEvent() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM eventos').get();

  if (count === 0) {
    const e = CONFIG.SEED_EVENT;

    db.prepare(`
      INSERT INTO eventos (nombre, fecha, lugar, precio, aforo)
      VALUES (?, ?, ?, ?, ?)
    `).run(e.nombre, e.fecha, e.lugar, e.precio, e.aforo);
  }
}

createSchema();
migrateSchema();
seedInitialEvent();


// =====================================================
// 3. BLOCKCHAIN
// =====================================================

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
      .update(
        String(this.index) +
        this.previousHash +
        String(this.timestamp) +
        JSON.stringify(this.transactions) +
        String(this.nonce)
      )
      .digest('hex');
  }

  mineBlock(difficulty) {
    const target = '0'.repeat(difficulty);

    while (!this.hash.startsWith(target)) {
      this.nonce++;
      this.hash = this.calculateHash();
    }
  }
}

class PersistentBlockchain {
  constructor(difficulty) {
    this.difficulty = difficulty;
    this.initGenesisBlock();
  }

  initGenesisBlock() {
    const genesis = db.prepare('SELECT * FROM blockchain WHERE idx = 0').get();

    if (genesis) return;

    const genesisBlock = new Block(
      0,
      Date.now(),
      [{ tipo: 'GENESIS', info: 'Génesis TicketChain' }],
      '0'
    );

    genesisBlock.mineBlock(this.difficulty);
    this.saveBlock(genesisBlock);
  }

  getLatestBlock() {
    const row = db
      .prepare('SELECT * FROM blockchain ORDER BY idx DESC LIMIT 1')
      .get();

    return new Block(
      row.idx,
      row.timestamp,
      JSON.parse(row.transactions),
      row.previousHash,
      row.nonce,
      row.hash
    );
  }

  saveBlock(block) {
    db.prepare(`
      INSERT INTO blockchain
      (idx, timestamp, transactions, previousHash, nonce, hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      block.index,
      block.timestamp,
      JSON.stringify(block.transactions),
      block.previousHash,
      block.nonce,
      block.hash
    );
  }

  addBlock(transactions) {
    const latestBlock = this.getLatestBlock();

    const newBlock = new Block(
      latestBlock.index + 1,
      Date.now(),
      transactions,
      latestBlock.hash
    );

    newBlock.mineBlock(this.difficulty);
    this.saveBlock(newBlock);

    return newBlock;
  }

  getChain() {
    const rows = db
      .prepare('SELECT * FROM blockchain ORDER BY idx ASC')
      .all();

    return rows.map(row => ({
      index: row.idx,
      timestamp: row.timestamp,
      transactions: JSON.parse(row.transactions),
      previousHash: row.previousHash,
      nonce: row.nonce,
      hash: row.hash
    }));
  }

  isChainValid() {
    const chain = this.getChain();

    for (let i = 1; i < chain.length; i++) {
      const data = chain[i];
      const previous = chain[i - 1];

      const current = new Block(
        data.index,
        data.timestamp,
        data.transactions,
        data.previousHash,
        data.nonce,
        data.hash
      );

      if (current.hash !== current.calculateHash()) return false;
      if (current.previousHash !== previous.hash) return false;
    }

    return true;
  }
}

const chainInstance = new PersistentBlockchain(CONFIG.BLOCKCHAIN_DIFFICULTY);


// =====================================================
// 4. UTILIDADES GENERALES
// =====================================================

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function toText(value) {
  return String(value || '').trim();
}

function sendError(res, status, error) {
  return res.status(status).json({ error });
}

function formatCOP(value) {
  return value.toLocaleString('es-CO');
}


// =====================================================
// 5. REPOSITORIOS (acceso a datos)
// =====================================================

const userRepo = {
  findByEmail(email) {
    return db
      .prepare(`
        SELECT id, name, email, bio, isAdmin
        FROM users
        WHERE lower(email) = lower(?)
      `)
      .get(email);
  },

  findByCredentials(email, pass) {
    return db
      .prepare(`
        SELECT id, name, email, bio, isAdmin
        FROM users
        WHERE lower(email) = lower(?)
          AND pass = ?
      `)
      .get(email, pass);
  },

  create({ name, email, pass, bio, isAdmin }) {
    db.prepare(`
      INSERT INTO users (name, email, pass, bio, isAdmin)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, email, pass, bio, isAdmin);
  }
};

const eventRepo = {
  findById(id) {
    return db.prepare('SELECT * FROM eventos WHERE id = ?').get(id);
  },

  listIdsDesc() {
    return db.prepare('SELECT * FROM eventos ORDER BY id DESC').all();
  },

  create({ nombre, fecha, lugar, precio, aforo }) {
    const info = db
      .prepare(`
        INSERT INTO eventos (nombre, fecha, lugar, precio, aforo)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(nombre, fecha, lugar, precio, aforo);

    return Number(info.lastInsertRowid);
  },

  // Evento + aforo vendido y disponible
  findWithStock(id) {
    const evento = this.findById(id);
    if (!evento) return null;

    const { vendidas } = db
      .prepare('SELECT COUNT(*) AS vendidas FROM tickets WHERE eventoId = ?')
      .get(id);

    return {
      ...evento,
      vendidas,
      disponibles: Math.max(evento.aforo - vendidas, 0)
    };
  }
};

const TICKET_PUBLIC_FIELDS = `
  ticketId, eventoId, evento, propietario,
  precio, precioOriginal, estado, enVenta
`;

const ticketRepo = {
  exists(ticketId) {
    return Boolean(
      db.prepare('SELECT 1 FROM tickets WHERE ticketId = ?').get(ticketId)
    );
  },

  findById(ticketId) {
    return db
      .prepare('SELECT * FROM tickets WHERE ticketId = ?')
      .get(ticketId);
  },

  findByIdAndOwner(ticketId, owner) {
    return db
      .prepare(`
        SELECT *
        FROM tickets
        WHERE ticketId = ?
          AND lower(propietario) = lower(?)
      `)
      .get(ticketId, owner);
  },

  findOnResale(ticketId) {
    return db
      .prepare('SELECT * FROM tickets WHERE ticketId = ? AND enVenta = 1')
      .get(ticketId);
  },

  countByEvent(eventoId) {
    return db
      .prepare('SELECT COUNT(*) AS count FROM tickets WHERE eventoId = ?')
      .get(eventoId).count;
  },

  insert({ ticketId, evento, propietario, precio }) {
    db.prepare(`
      INSERT INTO tickets
      (ticketId, eventoId, evento, propietario, precio, precioOriginal, estado, enVenta)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      ticketId,
      evento.id,
      evento.nombre,
      propietario,
      precio,
      precio,
      TICKET_STATE.VALID
    );
  },

  publishForResale(ticketId, precio) {
    db.prepare(`
      UPDATE tickets
      SET enVenta = 1, precio = ?
      WHERE ticketId = ?
    `).run(precio, ticketId);
  },

  completeResale(ticketId, newOwner) {
    db.prepare(`
      UPDATE tickets
      SET propietario = ?, enVenta = 0
      WHERE ticketId = ?
    `).run(newOwner, ticketId);
  },

  transfer(ticketId, newOwner) {
    db.prepare(`
      UPDATE tickets
      SET propietario = ?
      WHERE ticketId = ?
    `).run(newOwner, ticketId);
  },

  markAsUsed(ticketId) {
    db.prepare(`
      UPDATE tickets
      SET estado = ?, enVenta = 0
      WHERE ticketId = ?
    `).run(TICKET_STATE.USED, ticketId);
  },

  listAll() {
    return db
      .prepare(`SELECT ${TICKET_PUBLIC_FIELDS} FROM tickets ORDER BY rowid DESC`)
      .all()
      .map(serializeTicket);
  },

  findPublic(ticketId) {
    const ticket = db
      .prepare(`SELECT ${TICKET_PUBLIC_FIELDS} FROM tickets WHERE ticketId = ?`)
      .get(ticketId);

    return ticket ? serializeTicket(ticket) : null;
  }
};

function serializeTicket(ticket) {
  return { ...ticket, enVenta: Boolean(ticket.enVenta) };
}

function generateTicketId() {
  let id;

  do {
    id = 'TCK-' + crypto.randomBytes(5).toString('hex').toUpperCase();
  } while (ticketRepo.exists(id));

  return id;
}


// =====================================================
// 6. AUTENTICACIÓN / AUTORIZACIÓN
// =====================================================

// Devuelve el usuario o responde 401 y devuelve null
function requireUser(email, res) {
  const user = userRepo.findByEmail(email);

  if (!user) {
    sendError(res, 401, 'Usuario no autenticado o no existe');
    return null;
  }

  return user;
}

// Devuelve el usuario admin o responde 401/403 y devuelve null
function requireAdmin(email, res) {
  const user = requireUser(email, res);
  if (!user) return null;

  if (!Boolean(user.isAdmin)) {
    sendError(res, 403, 'Esta operación requiere permisos de administrador');
    return null;
  }

  return user;
}


// =====================================================
// 7. HANDLERS: USUARIOS
// =====================================================

function register(req, res) {
  const name = toText(req.body.name);
  const email = normalizeEmail(req.body.email);
  const pass = String(req.body.pass || '');
  const bio = toText(req.body.bio);

  if (!name || !email || !pass) {
    return sendError(res, 400, 'Nombre, correo y contraseña son obligatorios');
  }

  if (userRepo.findByEmail(email)) {
    return sendError(res, 400, 'El usuario ya está registrado');
  }

  // Para la demostración: cualquier correo que contenga "admin" es administrador.
  const isAdmin = email.includes('admin') ? 1 : 0;

  userRepo.create({
    name,
    email,
    pass,
    bio: bio || 'bio_default',
    isAdmin
  });

  res.json({
    message: isAdmin
      ? 'Usuario administrador registrado correctamente'
      : 'Usuario registrado correctamente'
  });
}

function login(req, res) {
  const email = normalizeEmail(req.body.email);
  const pass = String(req.body.pass || '');

  const user = userRepo.findByCredentials(email, pass);

  if (!user) {
    return sendError(res, 401, 'Credenciales inválidas');
  }

  res.json({
    user: { ...user, isAdmin: Boolean(user.isAdmin) }
  });
}


// =====================================================
// 8. HANDLERS: EVENTOS
// =====================================================

function listEvents(req, res) {
  const eventos = eventRepo
    .listIdsDesc()
    .map(evento => eventRepo.findWithStock(evento.id));

  res.json(eventos);
}

function createEvent(req, res) {
  const { nombre, fecha, lugar, precio, aforo, adminEmail } = req.body;

  if (!requireAdmin(adminEmail, res)) return;

  const cleanName = toText(nombre);
  const cleanDate = toText(fecha);
  const cleanPlace = toText(lugar);
  const price = Number(precio);
  const capacity = Number(aforo);

  if (
    !cleanName ||
    !cleanDate ||
    !cleanPlace ||
    !Number.isFinite(price) ||
    price < 0 ||
    !Number.isInteger(capacity) ||
    capacity <= 0
  ) {
    return sendError(
      res,
      400,
      'Nombre, fecha, lugar, precio y aforo deben ser válidos'
    );
  }

  const eventoId = eventRepo.create({
    nombre: cleanName,
    fecha: cleanDate,
    lugar: cleanPlace,
    precio: price,
    aforo: capacity
  });

  const evento = eventRepo.findWithStock(eventoId);

  chainInstance.addBlock([{
    tipo: 'CREACION_EVENTO',
    eventoId: evento.id,
    nombre: evento.nombre,
    fecha: evento.fecha,
    lugar: evento.lugar,
    precio: evento.precio,
    aforo: evento.aforo,
    creadoPor: normalizeEmail(adminEmail)
  }]);

  res.json({ message: 'Evento creado con éxito', evento });
}


// =====================================================
// 9. HANDLERS: TICKETS - EMISIÓN Y COMPRA
// =====================================================

function issueCourtesies(req, res) {
  const { eventoId, destinatario, cantidad, adminEmail } = req.body;

  if (!requireAdmin(adminEmail, res)) return;

  const evento = eventRepo.findById(eventoId);

  if (!evento) {
    return sendError(res, 404, 'Evento no encontrado');
  }

  const recipient = normalizeEmail(destinatario);

  if (!userRepo.findByEmail(recipient)) {
    return sendError(res, 404, 'El destinatario debe estar registrado');
  }

  const qty = Number(cantidad);

  if (!Number.isInteger(qty) || qty <= 0 || qty > CONFIG.MAX_COURTESY_QTY) {
    return sendError(
      res,
      400,
      `La cantidad de cortesías debe estar entre 1 y ${CONFIG.MAX_COURTESY_QTY}`
    );
  }

  const stock = eventRepo.findWithStock(eventoId);

  if (qty > stock.disponibles) {
    return sendError(
      res,
      400,
      `No hay aforo suficiente. Disponibles: ${stock.disponibles}`
    );
  }

  const tickets = [];

  db.transaction(() => {
    for (let i = 0; i < qty; i++) {
      const ticketId = generateTicketId();

      ticketRepo.insert({
        ticketId,
        evento,
        propietario: recipient,
        precio: 0
      });

      tickets.push(ticketId);
    }
  })();

  chainInstance.addBlock([{
    tipo: 'EMISION_CORTESIAS',
    eventoId: evento.id,
    evento: evento.nombre,
    cantidad: qty,
    destinatario: recipient,
    emitidoPor: normalizeEmail(adminEmail),
    tickets
  }]);

  res.json({
    message: `${qty} cortesía(s) emitida(s) correctamente`,
    tickets
  });
}

function buyTicket(req, res) {
  const eventoId = Number(req.body.eventoId);
  const email = normalizeEmail(req.body.email);

  if (!requireUser(email, res)) return;

  const evento = eventRepo.findById(eventoId);

  if (!evento) {
    return sendError(res, 404, 'Evento no encontrado');
  }

  const ticketId = generateTicketId();

  try {
    db.transaction(() => {
      if (ticketRepo.countByEvent(eventoId) >= evento.aforo) {
        throw new Error('AFORO_COMPLETO');
      }

      ticketRepo.insert({
        ticketId,
        evento,
        propietario: email,
        precio: evento.precio
      });
    })();
  } catch (error) {
    if (error.message === 'AFORO_COMPLETO') {
      return sendError(res, 409, 'El evento ya alcanzó el aforo máximo');
    }

    console.error(error);
    return sendError(res, 500, 'No fue posible generar el ticket');
  }

  chainInstance.addBlock([{
    tipo: 'COMPRA_DIRECTA',
    ticketId,
    comprador: email,
    eventoId: evento.id,
    evento: evento.nombre,
    precio: evento.precio
  }]);

  res.json({ message: 'Ticket comprado con éxito', ticketId });
}


// =====================================================
// 10. HANDLERS: TICKETS - REVENTA Y TRANSFERENCIA
// =====================================================

// Comprador A publica en reventa
function resellTicket(req, res) {
  const ticketId = toText(req.body.ticketId);
  const propietario = normalizeEmail(req.body.propietario);
  const precio = Number(req.body.precio);

  if (!requireUser(propietario, res)) return;

  const ticket = ticketRepo.findByIdAndOwner(ticketId, propietario);

  if (!ticket) {
    return sendError(res, 404, 'Ticket no encontrado o no te pertenece');
  }

  if (ticket.estado !== TICKET_STATE.VALID) {
    return sendError(
      res,
      400,
      'Solo se pueden revender entradas válidas y no usadas'
    );
  }

  if (ticket.enVenta) {
    return sendError(res, 400, 'El ticket ya está publicado en reventa');
  }

  // Las cortesías no pueden revenderse.
  if (ticket.precioOriginal <= 0) {
    return sendError(
      res,
      400,
      'Las entradas de cortesía no se pueden revender'
    );
  }

  const maxPrice = ticket.precioOriginal + CONFIG.MAX_RESALE_EXTRA;

  if (
    !Number.isFinite(precio) ||
    precio < ticket.precioOriginal ||
    precio > maxPrice
  ) {
    return sendError(
      res,
      400,
      `El precio debe estar entre $${formatCOP(ticket.precioOriginal)} y $${formatCOP(maxPrice)} COP`
    );
  }

  ticketRepo.publishForResale(ticketId, precio);

  // El ticket desaparece de "Mis entradas" y aparece en el mercado.
  chainInstance.addBlock([{
    tipo: 'PUBLICAR_REVENTA',
    ticketId,
    evento: ticket.evento,
    vendedor: propietario,
    precioOriginal: ticket.precioOriginal,
    precioReventa: precio,
    maximoPermitido: maxPrice
  }]);

  res.json({
    message: 'Ticket publicado en el mercado',
    ticketId,
    precioReventa: precio,
    maximoPermitido: maxPrice
  });
}

// Comprador B compra en reventa (A -> B)
function buyResoldTicket(req, res) {
  const ticketId = toText(req.body.ticketId);
  const comprador = normalizeEmail(req.body.comprador);

  if (!requireUser(comprador, res)) return;

  const ticket = ticketRepo.findOnResale(ticketId);

  if (!ticket) {
    return sendError(res, 404, 'Ticket no disponible para reventa');
  }

  if (ticket.estado !== TICKET_STATE.VALID) {
    return sendError(res, 400, 'El ticket no está válido para compra');
  }

  if (normalizeEmail(ticket.propietario) === comprador) {
    return sendError(res, 400, 'No puedes comprar tu propio ticket');
  }

  const vendedor = ticket.propietario;

  ticketRepo.completeResale(ticketId, comprador);

  chainInstance.addBlock([{
    tipo: 'COMPRA_REVENTA',
    ticketId,
    evento: ticket.evento,
    de: vendedor,
    para: comprador,
    precio: ticket.precio
  }]);

  // Cambio explícito de dueño A -> B.
  chainInstance.addBlock([{
    tipo: 'CAMBIO_DUENO',
    ticketId,
    evento: ticket.evento,
    anterior: vendedor,
    nuevo: comprador,
    motivo: 'REVENTA'
  }]);

  res.json({
    message: `Compra realizada. El propietario cambió de ${vendedor} a ${comprador}.`
  });
}

// Transferencia directa (Comprador A -> Comprador B)
function transferTicket(req, res) {
  const ticketId = toText(req.body.ticketId);
  const remitente = normalizeEmail(req.body.remitente);
  const nuevoPropietario = normalizeEmail(req.body.nuevoPropietario);

  if (!requireUser(remitente, res)) return;

  if (!nuevoPropietario) {
    return sendError(
      res,
      400,
      'Debes indicar el correo del nuevo propietario'
    );
  }

  if (remitente === nuevoPropietario) {
    return sendError(
      res,
      400,
      'El nuevo propietario debe ser diferente al actual'
    );
  }

  // El comprador B debe existir.
  if (!userRepo.findByEmail(nuevoPropietario)) {
    return sendError(res, 404, 'El destinatario no está registrado');
  }

  const ticket = ticketRepo.findByIdAndOwner(ticketId, remitente);

  if (!ticket) {
    return sendError(res, 404, 'Ticket no encontrado o no te pertenece');
  }

  if (ticket.estado !== TICKET_STATE.VALID) {
    return sendError(
      res,
      400,
      'No se puede transferir una entrada ya utilizada'
    );
  }

  if (ticket.enVenta) {
    return sendError(
      res,
      400,
      'Retira el ticket del mercado antes de transferirlo'
    );
  }

  ticketRepo.transfer(ticketId, nuevoPropietario);

  chainInstance.addBlock([{
    tipo: 'TRANSFERENCIA',
    ticketId,
    evento: ticket.evento,
    de: remitente,
    para: nuevoPropietario
  }]);

  chainInstance.addBlock([{
    tipo: 'CAMBIO_DUENO',
    ticketId,
    evento: ticket.evento,
    anterior: remitente,
    nuevo: nuevoPropietario,
    motivo: 'TRANSFERENCIA'
  }]);

  res.json({
    message: `Ticket transferido. Nuevo propietario: ${nuevoPropietario}`
  });
}


// =====================================================
// 11. HANDLERS: VALIDACIÓN EN PUERTA (VALIDO -> USADO)
// =====================================================

function validateTicket(req, res) {
  const hash = toText(req.body.hash);
  const email = normalizeEmail(req.body.email);
  const adminEmail = normalizeEmail(req.body.adminEmail);

  if (!requireAdmin(adminEmail, res)) return;

  const deny = (status, message) =>
    res.status(status).json({ access: false, message });

  const ticket = ticketRepo.findById(hash);

  if (!ticket) {
    return deny(404, 'Entrada inválida o no existente');
  }

  if (ticket.propietario !== email) {
    return deny(403, 'La entrada no pertenece a este correo');
  }

  if (ticket.estado === TICKET_STATE.USED) {
    return deny(400, 'Esta entrada ya fue utilizada');
  }

  if (ticket.estado !== TICKET_STATE.VALID) {
    return deny(400, 'La entrada no está en estado válido');
  }

  ticketRepo.markAsUsed(hash);

  chainInstance.addBlock([{
    tipo: 'INGRESO_EVENTO',
    ticketId: hash,
    evento: ticket.evento,
    asistente: email,
    fecha: new Date().toISOString(),
    estadoAnterior: TICKET_STATE.VALID,
    estadoNuevo: TICKET_STATE.USED
  }]);

  res.json({
    access: true,
    message: 'Acceso concedido. Entrada válida y marcada como USADA.'
  });
}


// =====================================================
// 12. HANDLERS: CONSULTAS Y ESTADO
// =====================================================

function getChainStatus(req, res) {
  const chain = chainInstance.getChain();

  res.json({
    length: chain.length,
    valid: chainInstance.isChainValid(),
    chain,
    tickets: ticketRepo.listAll()
  });
}

function getTicket(req, res) {
  const ticket = ticketRepo.findPublic(req.params.ticketId);

  if (!ticket) {
    return sendError(res, 404, 'Ticket no encontrado');
  }

  res.json(ticket);
}

function healthCheck(req, res) {
  res.json({
    ok: true,
    servicio: 'TicketChain',
    blockchainValida: chainInstance.isChainValid()
  });
}


// =====================================================
// 13. APP EXPRESS: MIDDLEWARE Y RUTAS
// =====================================================

const app = express();

app.use(cors());
app.use(express.json());

// Usuarios
app.post('/api/register', register);
app.post('/api/login', login);

// Eventos
app.get('/api/eventos', listEvents);
app.post('/api/eventos', createEvent);

// Tickets
app.post('/api/tickets/courtesy', issueCourtesies);
app.post('/api/tickets/buy', buyTicket);
app.post('/api/tickets/resell', resellTicket);
app.post('/api/tickets/buy-resell', buyResoldTicket);
app.post('/api/tickets/transfer', transferTicket);
app.post('/api/tickets/validate', validateTicket);
app.get('/api/tickets/:ticketId', getTicket);

// Blockchain / sistema
app.get('/api/chain-status', getChainStatus);
app.get('/api/health', healthCheck);


// =====================================================
// 14. INICIO DEL SERVIDOR
// =====================================================

app.listen(CONFIG.PORT, () => {
  console.log(`Servidor activo en http://localhost:${CONFIG.PORT}`);
  console.log(`Base de datos: ${CONFIG.DB_FILE}`);
});
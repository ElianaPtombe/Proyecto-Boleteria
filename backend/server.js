const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// Base de datos en memoria para la demo
const users = [];
const eventos = [
  { id: 1, nombre: 'Concierto Rock Fest', fecha: '20 Oct, 2026', lugar: 'Estadio El Campín', precio: 150000, aforo: 500 },
  { id: 2, nombre: 'Festival de Jazz', fecha: '15 Nov, 2026', lugar: 'Teatro Colón', precio: 120000, aforo: 300 },
  { id: 3, nombre: 'Obra de Teatro "La Casa de Bernarda Alba"', fecha: '10 Dic, 2026', lugar: 'Teatro Nacional', precio: 80000, aforo: 200 },
  { id: 4, nombre: 'Conferencia de Tecnología', fecha: '5 Ene, 2027', lugar: 'Centro de Convenciones', precio: 100000, aforo: 400 },
  { id: 5, nombre: 'Feria de Arte Contemporáneo', fecha: '25 Feb, 2027', lugar: 'Museo de Arte Moderno', precio: 50000, aforo: 150 }
  
];

// Estructura de la Blockchain
class Block {
  constructor(index, timestamp, transactions, previousHash = '') {
    this.index = index;
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.previousHash = previousHash;
    this.nonce = 0;
    this.hash = this.calculateHash();
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

class Blockchain {
  constructor() {
    this.chain = [this.createGenesisBlock()];
    this.difficulty = 2;
    this.tickets = []; // Estado global de tickets
  }

  createGenesisBlock() {
    return new Block(0, Date.now(), [{ info: "Génesis TicketChain" }], "0");
  }

  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  addBlock(transactions) {
    const newBlock = new Block(this.chain.length, Date.now(), transactions, this.getLatestBlock().hash);
    newBlock.mineBlock(this.difficulty);
    this.chain.push(newBlock);
  }

  isChainValid() {
    for (let i = 1; i < this.chain.length; i++) {
      const currentBlock = this.chain[i];
      const previousBlock = this.chain[i - 1];

      if (currentBlock.hash !== currentBlock.calculateHash()) return false;
      if (currentBlock.previousHash !== previousBlock.hash) return false;
    }
    return true;
  }
}

const chainInstance = new Blockchain();

// --- RUTAS API ---

// 1. Autenticación
app.post('/api/register', (req, res) => {
  const { name, email, pass, bio } = req.body;
  if (users.find(u => u.email === email)) {
    return res.status(400).json({ error: 'El usuario ya existe' });
  }
  const newUser = { id: Date.now(), name, email, pass, bio: bio || 'bio_default', isAdmin: email.includes('admin') };
  users.push(newUser);
  res.json({ message: 'Usuario registrado correctamente' });
});

app.post('/api/login', (req, res) => {
  const { email, pass } = req.body;
  const user = users.find(u => u.email === email && u.pass === pass);
  if (!user) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  res.json({ user });
});

// 2. Obtener lista de eventos
app.get('/api/eventos', (req, res) => {
  res.json(eventos);
});

// 3. Crear nuevo evento 
app.post('/api/eventos', (req, res) => {
  const { nombre, fecha, lugar, precio, aforo, adminEmail } = req.body;

  if (!nombre || !fecha || !lugar || precio === undefined || !aforo) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }

  const nuevoEvento = {
    id: eventos.length + 1,
    nombre,
    fecha,
    lugar,
    precio: parseFloat(precio),
    aforo: parseInt(aforo)
  };

  eventos.push(nuevoEvento);

  // Registrar creación del evento en la Blockchain
  chainInstance.addBlock([{
    tipo: 'CREACION_EVENTO',
    eventoId: nuevoEvento.id,
    nombre: nuevoEvento.nombre,
    creadoPor: adminEmail || 'Admin'
  }]);

  res.json({ message: 'Evento creado con éxito', evento: nuevoEvento });
});

// 4. Comprar Ticket directo
app.post('/api/tickets/buy', (req, res) => {
  const { eventoId, email } = req.body;
  const evento = eventos.find(e => e.id === eventoId);

  if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });

  const ticketId = 'TICK-' + crypto.randomBytes(4).toString('hex').toUpperCase();

  const ticket = {
    ticketId,
    eventoId,
    evento: evento.nombre,
    propietario: email,
    precio: evento.precio,
    estado: 'VALIDO',
    enVenta: false
  };

  chainInstance.tickets.push(ticket);
  chainInstance.addBlock([{ tipo: 'COMPRA_DIRECTA', ticketId, comprador: email, evento: evento.nombre }]);

  res.json({ message: 'Ticket comprado con éxito', ticket });
});

// 5. Revender Ticket
app.post('/api/tickets/resell', (req, res) => {
  const { ticketId, precio, propietario } = req.body;
  const ticket = chainInstance.tickets.find(t => t.ticketId === ticketId && t.propietario === propietario);

  if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado o no te pertenece' });

  ticket.enVenta = true;
  ticket.precio = parseFloat(precio);

  chainInstance.addBlock([{ tipo: 'PUBLICAR_REVENTA', ticketId, nuevoPrecio: precio, vendedor: propietario }]);
  res.json({ message: 'Ticket puesto en reventa' });
});

// 6. Comprar Reventa
app.post('/api/tickets/buy-resell', (req, res) => {
  const { ticketId, comprador } = req.body;
  const ticket = chainInstance.tickets.find(t => t.ticketId === ticketId && t.enVenta);

  if (!ticket) return res.status(404).json({ error: 'Ticket no disponible para reventa' });

  const anteriorPropietario = ticket.propietario;
  ticket.propietario = comprador;
  ticket.enVenta = false;

  chainInstance.addBlock([{ tipo: 'COMPRA_REVENTA', ticketId, de: anteriorPropietario, para: comprador, precio: ticket.precio }]);
  res.json({ message: 'Reventa completada con éxito' });
});

// 7. Transferir Ticket
app.post('/api/tickets/transfer', (req, res) => {
  const { ticketId, nuevoPropietario, remitente } = req.body;
  const ticket = chainInstance.tickets.find(t => t.ticketId === ticketId && t.propietario === remitente);

  if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });

  ticket.propietario = nuevoPropietario;
  chainInstance.addBlock([{ tipo: 'TRANSFERENCIA', ticketId, de: remitente, para: nuevoPropietario }]);
  res.json({ message: 'Ticket transferido correctamente' });
});

// 8. Validar Ticket en Puerta
app.post('/api/tickets/validate', (req, res) => {
  const { hash, email, bio } = req.body;
  const ticket = chainInstance.tickets.find(t => t.ticketId === hash);

  if (!ticket) {
    return res.status(404).json({ access: false, message: 'Entrada inválida o no existente' });
  }

  if (ticket.propietario !== email) {
    return res.status(403).json({ access: false, message: 'La entrada no pertenece a este correo' });
  }

  if (ticket.estado === 'USADO') {
    return res.status(400).json({ access: false, message: 'Esta entrada ya fue utilizada' });
  }

  ticket.estado = 'USADO';
  chainInstance.addBlock([{ tipo: 'INGRESO_EVENTO', ticketId: hash, asistente: email, fecha: new Date().toISOString() }]);

  res.json({ access: true, message: 'Acceso concedido. Entrada válida.' });
});

// 9. Estado de la Blockchain y Tickets
app.get('/api/chain-status', (req, res) => {
  res.json({
    length: chainInstance.chain.length,
    valid: chainInstance.isChainValid(),
    chain: chainInstance.chain,
    tickets: chainInstance.tickets
  });
});

// Iniciar servidor
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
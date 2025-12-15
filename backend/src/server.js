const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const redis = require('redis');
const promClient = require('prom-client');

const app = express();
const PORT = process.env.PORT || 4000;

// Prometheus metrics
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

// PostgreSQL connection
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'ecommerce',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
  max: 20
});

// Redis connection
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('Redis error:', err));
redisClient.connect();

// Middleware
app.use(cors());
app.use(express.json());

// Request timing middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    httpRequestDuration.labels(req.method, req.route?.path || req.path, res.statusCode).observe(duration);
  });
  next();
});

// Health check endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redisClient.ping();
    res.json({ status: 'ready' });
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: error.message });
  }
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Products API with caching
app.get('/api/products', async (req, res) => {
  try {
    // Check cache first
    const cached = await redisClient.get('products');
    if (cached) {
      console.log('Cache hit');
      return res.json(JSON.parse(cached));
    }

    // Query database
    const result = await pool.query(`
      SELECT id, name, description, price, stock, image_url, created_at 
      FROM products 
      WHERE stock > 0 
      ORDER BY created_at DESC
    `);

    // Cache for 5 minutes
    await redisClient.setEx('products', 300, JSON.stringify(result.rows));
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/orders', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { user_id, items } = req.body;
    
    // Create order
    const orderResult = await client.query(
      'INSERT INTO orders (user_id, status, total) VALUES ($1, $2, $3) RETURNING *',
      [user_id, 'pending', 0]
    );
    
    const orderId = orderResult.rows[0].id;
    let total = 0;

    // Add order items
    for (const item of items) {
      const product = await client.query('SELECT price FROM products WHERE id = $1', [item.product_id]);
      const price = product.rows[0].price;
      total += price * item.quantity;
      
      await client.query(
        'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ($1, $2, $3, $4)',
        [orderId, item.product_id, item.quantity, price]
      );
    }

    // Update order total
    await client.query('UPDATE orders SET total = $1 WHERE id = $2', [total, orderId]);
    
    await client.query('COMMIT');
    
    // Invalidate products cache
    await redisClient.del('products');
    
    res.status(201).json({ orderId, total });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Failed to create order' });
  } finally {
    client.release();
  }
});

// Initialize database schema
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10, 2) NOT NULL,
        stock INTEGER NOT NULL DEFAULT 0,
        image_url VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        status VARCHAR(50) NOT NULL,
        total DECIMAL(10, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id),
        product_id INTEGER REFERENCES products(id),
        quantity INTEGER NOT NULL,
        price DECIMAL(10, 2) NOT NULL
      );

      INSERT INTO products (name, description, price, stock, image_url) 
      VALUES 
        ('Laptop Pro', 'High-performance laptop', 1299.99, 50, 'https://via.placeholder.com/300?text=Laptop'),
        ('Wireless Mouse', 'Ergonomic wireless mouse', 29.99, 200, 'https://via.placeholder.com/300?text=Mouse'),
        ('Mechanical Keyboard', 'RGB mechanical keyboard', 89.99, 100, 'https://via.placeholder.com/300?text=Keyboard'),
        ('4K Monitor', '27-inch 4K display', 399.99, 75, 'https://via.placeholder.com/300?text=Monitor')
      ON CONFLICT DO NOTHING;
    `);
    console.log('Database initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

app.listen(PORT, async () => {
  await initDB();
  console.log(`Backend server running on port ${PORT}`);
});
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────
// CONEXIÓN A LA BASE DE DATOS POSTGRESQL
// ─────────────────────────────────────────────

const isLocal = !process.env.DATABASE_URL && (process.env.DB_HOST === 'localhost' || process.env.DB_HOST === '127.0.0.1' || !process.env.DB_HOST);
const ssl = isLocal ? false : { rejectUnauthorized: false };

const pool = new pg.Pool({
    host:     process.env.DB_HOST     || 'localhost',
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port:     parseInt(process.env.DB_PORT || '5432'),
    max: 10,
    idleTimeoutMillis: 30000,
    ssl:      ssl,
    // Soporte para DATABASE_URL (Railway, Render, Supabase, Neon, etc.)
    ...(process.env.DATABASE_URL && {
        connectionString: process.env.DATABASE_URL,
    }),
});

async function query(text, params = []) {
    const result = await pool.query(text, params);
    return { rows: result.rows };
}

// ─────────────────────────────────────────────
// SERVIDOR EXPRESS
// ─────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// Servir los archivos estáticos del frontend (index.html, app.js, styles.css)
app.use(express.static(__dirname));

// ─────────────────────────────────────────────
// AUTENTICACIÓN — JWT
// ─────────────────────────────────────────────

// POST /api/auth/login — obtener token JWT
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }

    const validUser = username === process.env.ADMIN_USERNAME;
    const validPass = process.env.ADMIN_PASSWORD_HASH
        ? await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH)
        : false;

    if (!validUser || !validPass) {
        return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    const token = jwt.sign(
        { username },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({ token, expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
});

// Middleware de autenticación JWT
function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token de autenticación requerido' });
    }

    try {
        const payload = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
        req.user = payload;
        next();
    } catch {
        return res.status(401).json({ error: 'Token inválido o expirado' });
    }
}

// ─────────────────────────────────────────────
// ENDPOINTS — CABAÑAS
// ─────────────────────────────────────────────

// GET /api/cabanas — lista todas las cabañas activas
app.get('/api/cabanas', requireAuth, async (req, res) => {
    try {
        const result = await query(
            `SELECT id, nombre, capacidad, hue, activa
             FROM cabanas
             WHERE activa = TRUE
             ORDER BY id`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('GET /api/cabanas:', err.message);
        res.status(500).json({ error: 'Error al obtener cabañas' });
    }
});

// ─────────────────────────────────────────────
// ENDPOINTS — RESERVAS
// ─────────────────────────────────────────────

// GET /api/reservas — lista reservas (opcionalmente filtradas por estado)
// Query params: estado=confirmada|pendiente|cancelada|completada|todas
app.get('/api/reservas', requireAuth, async (req, res) => {
    try {
        const { estado } = req.query;
        const estadosValidos = ['pendiente', 'confirmada', 'cancelada', 'completada'];

        let whereClause = `WHERE r.estado IN ('pendiente', 'confirmada')`;
        let params = [];

        if (estado === 'todas') {
            whereClause = '';
        } else if (estado && estadosValidos.includes(estado)) {
            whereClause = `WHERE r.estado = $1`;
            params = [estado];
        }

        const result = await query(
            `SELECT
               r.id,
               r.cabana_id       AS "cabinId",
               r.check_in        AS "checkIn",
               r.check_out       AS "checkOut",
               r.nombre_huesped  AS "guestName",
               r.telefono        AS phone,
               r.whatsapp_jid    AS "whatsappJid",
               r.personas        AS guests,
               r.notas           AS notes,
               r.origen          AS origen,
               r.estado          AS estado,
               r.confirmada_por  AS "confirmadaPor",
               r.confirmada_en   AS "confirmadaEn",
               r.creado_en       AS "creadoEn",
               c.nombre          AS "cabinName",
               c.hue             AS hue
             FROM reservas r
             JOIN cabanas c ON c.id = r.cabana_id
             ${whereClause}
             ORDER BY r.check_in ASC`,
            params
        );
        res.json(result.rows);
    } catch (err) {
        console.error('GET /api/reservas:', err.message);
        res.status(500).json({ error: 'Error al obtener reservas' });
    }
});

// GET /api/reservas/:id — detalle de una reserva
app.get('/api/reservas/:id', requireAuth, async (req, res) => {
    try {
        const result = await query(
            `SELECT
               r.*,
               c.nombre AS "cabinName",
               c.hue    AS hue
             FROM reservas r
             JOIN cabanas c ON c.id = r.cabana_id
             WHERE r.id = $1`,
            [req.params.id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Reserva no encontrada' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('GET /api/reservas/:id:', err.message);
        res.status(500).json({ error: 'Error al obtener reserva' });
    }
});

// POST /api/reservas — crear nueva reserva (desde el panel web, estado confirmada directo)
app.post('/api/reservas', requireAuth, async (req, res) => {
    const { cabinId, checkIn, checkOut, guestName, phone, guests, notes } = req.body;

    if (!cabinId || !checkIn || !checkOut || !guestName || !phone) {
        return res.status(400).json({ error: 'Faltan campos obligatorios: cabinId, checkIn, checkOut, guestName, phone' });
    }

    if (checkOut <= checkIn) {
        return res.status(400).json({ error: 'La fecha de salida debe ser posterior a la de entrada' });
    }

    try {
        // Verificar disponibilidad (solo contra reservas confirmadas y pendientes)
        const conflicto = await query(
            `SELECT id FROM reservas
             WHERE cabana_id = $1
               AND estado IN ('pendiente', 'confirmada')
               AND check_in  < $2
               AND check_out > $3`,
            [cabinId, checkOut, checkIn]
        );

        if (conflicto.rows.length > 0) {
            return res.status(409).json({ error: 'La cabaña ya tiene una reserva en esas fechas' });
        }

        const id = `r${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 5).toUpperCase()}`;

        await query(
            `INSERT INTO reservas
               (id, cabana_id, check_in, check_out, nombre_huesped, telefono,
                personas, notas, origen, estado, confirmada_por, confirmada_en)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'web', 'confirmada', 'admin', NOW())`,
            [id, cabinId, checkIn, checkOut, guestName.trim(), phone.trim(),
             guests || 1, notes?.trim() || null]
        );

        const result = await query(
            `SELECT r.*, c.nombre AS "cabinName", c.hue
             FROM reservas r JOIN cabanas c ON c.id = r.cabana_id
             WHERE r.id = $1`,
            [id]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('POST /api/reservas:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/reservas/:id — actualizar estado o datos de una reserva
app.patch('/api/reservas/:id', requireAuth, async (req, res) => {
    const { estado, confirmadaPor, notes } = req.body;
    const estadosValidos = ['pendiente', 'confirmada', 'cancelada', 'completada'];

    if (estado && !estadosValidos.includes(estado)) {
        return res.status(400).json({ error: `Estado inválido. Valores permitidos: ${estadosValidos.join(', ')}` });
    }

    try {
        const sets = [];
        const params = [];
        let idx = 1;

        if (estado) {
            sets.push(`estado = $${idx++}`);
            params.push(estado);
            if (estado === 'confirmada') {
                sets.push(`confirmada_por = $${idx++}`);
                params.push(confirmadaPor || 'admin');
                sets.push(`confirmada_en = NOW()`);
            }
        }
        if (notes !== undefined) {
            sets.push(`notas = $${idx++}`);
            params.push(notes);
        }

        if (!sets.length) return res.status(400).json({ error: 'No hay campos para actualizar' });

        params.push(req.params.id);
        await query(
            `UPDATE reservas SET ${sets.join(', ')} WHERE id = $${idx}`,
            params
        );

        const result = await query(`SELECT * FROM reservas WHERE id = $1`, [req.params.id]);
        if (!result.rows.length) return res.status(404).json({ error: 'Reserva no encontrada' });

        // Si se confirma o cancela, marcar la notificación como resuelta
        if (estado === 'confirmada' || estado === 'cancelada') {
            await query(
                `UPDATE notificaciones_admin SET resuelta = TRUE, resuelta_en = NOW()
                 WHERE reserva_id = $1 AND resuelta = FALSE`,
                [req.params.id]
            );
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('PATCH /api/reservas/:id:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/reservas/:id — cancelar reserva (cambia estado a cancelada, no borra)
app.delete('/api/reservas/:id', requireAuth, async (req, res) => {
    try {
        const check = await query(`SELECT id FROM reservas WHERE id = $1`, [req.params.id]);
        if (!check.rows.length) return res.status(404).json({ error: 'Reserva no encontrada' });

        await query(
            `UPDATE reservas SET estado = 'cancelada' WHERE id = $1`,
            [req.params.id]
        );
        res.json({ ok: true, id: req.params.id });
    } catch (err) {
        console.error('DELETE /api/reservas/:id:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// ENDPOINTS — NOTIFICACIONES (reservas del bot pendientes)
// ─────────────────────────────────────────────

// GET /api/notificaciones — notificaciones sin resolver
app.get('/api/notificaciones', requireAuth, async (req, res) => {
    try {
        const result = await query(
            `SELECT n.id, n.tipo, n.reserva_id, n.whatsapp_jid, n.mensaje,
                    n.leida, n.resuelta, n.creado_en,
                    r.nombre_huesped, r.check_in, r.check_out,
                    r.cabana_id, r.personas, r.estado AS reserva_estado
             FROM notificaciones_admin n
             LEFT JOIN reservas r ON r.id = n.reserva_id
             WHERE n.resuelta = FALSE
             ORDER BY n.creado_en ASC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('GET /api/notificaciones:', err.message);
        res.status(500).json({ error: 'Error al obtener notificaciones' });
    }
});

// PATCH /api/notificaciones/:id/leida — marcar como leída
app.patch('/api/notificaciones/:id/leida', requireAuth, async (req, res) => {
    try {
        await query(
            `UPDATE notificaciones_admin SET leida = TRUE WHERE id = $1`,
            [req.params.id]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// INICIO
// ─────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000');

app.listen(PORT, async () => {
    try {
        await pool.query('SELECT 1');
        console.log(`✅ Base de datos PostgreSQL conectada`);
    } catch (err) {
        console.error('❌ No se pudo conectar a la base de datos PostgreSQL:', err.message);
        process.exit(1);
    }
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});

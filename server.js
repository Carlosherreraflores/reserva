import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────
// CONEXIÓN A LA BASE DE DATOS MYSQL
// ─────────────────────────────────────────────

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '3306'),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true,
});

async function query(text, params = []) {
    const [rows] = await pool.query(text, params);
    return { rows };
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
// ENDPOINTS — CABAÑAS
// ─────────────────────────────────────────────

// GET /api/cabanas — lista todas las cabañas activas
app.get('/api/cabanas', async (req, res) => {
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
app.get('/api/reservas', async (req, res) => {
    try {
        const { estado } = req.query;
        const estadosValidos = ['pendiente', 'confirmada', 'cancelada', 'completada'];

        let whereClause = `WHERE r.estado IN ('pendiente', 'confirmada')`;
        let params = [];

        if (estado === 'todas') {
            whereClause = '';
        } else if (estado && estadosValidos.includes(estado)) {
            whereClause = `WHERE r.estado = ?`;
            params = [estado];
        }

        const result = await query(
            `SELECT
               r.id,
               r.cabana_id       AS cabinId,
               r.check_in        AS checkIn,
               r.check_out       AS checkOut,
               r.nombre_huesped  AS guestName,
               r.telefono        AS phone,
               r.whatsapp_jid    AS whatsappJid,
               r.personas        AS guests,
               r.notas           AS notes,
               r.origen          AS origen,
               r.estado          AS estado,
               r.confirmada_por  AS confirmadaPor,
               r.confirmada_en   AS confirmadaEn,
               r.creado_en       AS creadoEn,
               c.nombre          AS cabinName,
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
app.get('/api/reservas/:id', async (req, res) => {
    try {
        const result = await query(
            `SELECT
               r.*,
               c.nombre AS cabinName,
               c.hue    AS hue
             FROM reservas r
             JOIN cabanas c ON c.id = r.cabana_id
             WHERE r.id = ?`,
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
app.post('/api/reservas', async (req, res) => {
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
             WHERE cabana_id = ?
               AND estado IN ('pendiente', 'confirmada')
               AND check_in  < ?
               AND check_out > ?`,
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
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'web', 'confirmada', 'admin', NOW())`,
            [id, cabinId, checkIn, checkOut, guestName.trim(), phone.trim(),
             guests || 1, notes?.trim() || null]
        );

        const result = await query(
            `SELECT r.*, c.nombre AS cabinName, c.hue
             FROM reservas r JOIN cabanas c ON c.id = r.cabana_id
             WHERE r.id = ?`,
            [id]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('POST /api/reservas:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/reservas/:id — actualizar estado o datos de una reserva
app.patch('/api/reservas/:id', async (req, res) => {
    const { estado, confirmadaPor, notes } = req.body;
    const estadosValidos = ['pendiente', 'confirmada', 'cancelada', 'completada'];

    if (estado && !estadosValidos.includes(estado)) {
        return res.status(400).json({ error: `Estado inválido. Valores permitidos: ${estadosValidos.join(', ')}` });
    }

    try {
        const sets = [];
        const params = [];

        if (estado) {
            sets.push(`estado = ?`);
            params.push(estado);
            if (estado === 'confirmada') {
                sets.push(`confirmada_por = ?`);
                params.push(confirmadaPor || 'admin');
                sets.push(`confirmada_en = NOW()`);
            }
        }
        if (notes !== undefined) {
            sets.push(`notas = ?`);
            params.push(notes);
        }

        if (!sets.length) return res.status(400).json({ error: 'No hay campos para actualizar' });

        params.push(req.params.id);
        await query(
            `UPDATE reservas SET ${sets.join(', ')} WHERE id = ?`,
            params
        );

        const result = await query(`SELECT * FROM reservas WHERE id = ?`, [req.params.id]);
        if (!result.rows.length) return res.status(404).json({ error: 'Reserva no encontrada' });

        // Si se confirma o cancela, marcar la notificación como resuelta
        if (estado === 'confirmada' || estado === 'cancelada') {
            await query(
                `UPDATE notificaciones_admin SET resuelta = TRUE, resuelta_en = NOW()
                 WHERE reserva_id = ? AND resuelta = FALSE`,
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
app.delete('/api/reservas/:id', async (req, res) => {
    try {
        const check = await query(`SELECT id FROM reservas WHERE id = ?`, [req.params.id]);
        if (!check.rows.length) return res.status(404).json({ error: 'Reserva no encontrada' });

        await query(
            `UPDATE reservas SET estado = 'cancelada' WHERE id = ?`,
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
app.get('/api/notificaciones', async (req, res) => {
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
app.patch('/api/notificaciones/:id/leida', async (req, res) => {
    try {
        await query(
            `UPDATE notificaciones_admin SET leida = TRUE WHERE id = ?`,
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
        console.log(`✅ Base de datos MySQL conectada`);
    } catch (err) {
        console.error('❌ No se pudo conectar a la base de datos MySQL:', err.message);
        process.exit(1);
    }
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});

import pg from 'pg';

// ─────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ─────────────────────────────────────────────
// BASE DE DATOS
// ─────────────────────────────────────────────

const pool = new pg.Pool({
  ...(process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      }
    : {
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: parseInt(process.env.DB_PORT || '5432'),
      }),
  max: 5,
  idleTimeoutMillis: 30000,
});

async function query(text: string, params: unknown[] = []) {
  const result = await pool.query(text, params);
  return { rows: result.rows };
}

// ─────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────

export default async function handler(req: Request): Promise<Response> {
  // Preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  // La función se monta en /.netlify/functions/api
  // Las rutas llegan como: /api/cabanas, /api/reservas, etc.
  // Netlify pasa la ruta original en la URL, extraemos el path relevante
  let path = url.pathname;

  // Normalizar: quitar prefijo /.netlify/functions/api si está presente
  if (path.startsWith('/.netlify/functions/api')) {
    path = path.slice('/.netlify/functions/api'.length) || '/';
  }
  // Quitar prefijo /api si está presente (viene del redirect del netlify.toml)
  if (path.startsWith('/api')) {
    path = path.slice(4) || '/';
  }

  const method = req.method;

  try {
    // ── GET /cabanas ──────────────────────────
    if (method === 'GET' && path === '/cabanas') {
      const result = await query(
        `SELECT id, nombre, capacidad, hue, activa
         FROM cabanas
         WHERE activa = TRUE
         ORDER BY id`
      );
      return json(result.rows);
    }

    // ── GET /reservas ─────────────────────────
    if (method === 'GET' && path === '/reservas') {
      const estado = url.searchParams.get('estado');
      const estadosValidos = ['pendiente', 'confirmada', 'cancelada', 'completada'];

      let whereClause = `WHERE r.estado IN ('pendiente', 'confirmada')`;
      let params: unknown[] = [];

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
      return json(result.rows);
    }

    // ── GET /reservas/:id ─────────────────────
    const reservaIdMatch = path.match(/^\/reservas\/([^/]+)$/);
    if (method === 'GET' && reservaIdMatch) {
      const id = reservaIdMatch[1];
      const result = await query(
        `SELECT r.*, c.nombre AS "cabinName", c.hue
         FROM reservas r
         JOIN cabanas c ON c.id = r.cabana_id
         WHERE r.id = $1`,
        [id]
      );
      if (!result.rows.length) return json({ error: 'Reserva no encontrada' }, 404);
      return json(result.rows[0]);
    }

    // ── POST /reservas ────────────────────────
    if (method === 'POST' && path === '/reservas') {
      const body = await req.json();
      const { cabinId, checkIn, checkOut, guestName, phone, guests, notes } = body;

      if (!cabinId || !checkIn || !checkOut || !guestName || !phone) {
        return json({ error: 'Faltan campos obligatorios: cabinId, checkIn, checkOut, guestName, phone' }, 400);
      }
      if (checkOut <= checkIn) {
        return json({ error: 'La fecha de salida debe ser posterior a la de entrada' }, 400);
      }

      const conflicto = await query(
        `SELECT id FROM reservas
         WHERE cabana_id = $1
           AND estado IN ('pendiente', 'confirmada')
           AND check_in  < $2
           AND check_out > $3`,
        [cabinId, checkOut, checkIn]
      );
      if (conflicto.rows.length > 0) {
        return json({ error: 'La cabaña ya tiene una reserva en esas fechas' }, 409);
      }

      const id = `r${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
      await query(
        `INSERT INTO reservas
           (id, cabana_id, check_in, check_out, nombre_huesped, telefono,
            personas, notas, origen, estado, confirmada_por, confirmada_en)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'web', 'confirmada', 'admin', NOW())`,
        [id, cabinId, checkIn, checkOut, String(guestName).trim(), String(phone).trim(),
         guests || 1, notes ? String(notes).trim() : null]
      );

      const result = await query(
        `SELECT r.*, c.nombre AS "cabinName", c.hue
         FROM reservas r JOIN cabanas c ON c.id = r.cabana_id
         WHERE r.id = $1`,
        [id]
      );
      return json(result.rows[0], 201);
    }

    // ── PATCH /reservas/:id ───────────────────
    const patchReservaMatch = path.match(/^\/reservas\/([^/]+)$/);
    if (method === 'PATCH' && patchReservaMatch) {
      const id = patchReservaMatch[1];
      const body = await req.json();
      const { estado, confirmadaPor, notes } = body;
      const estadosValidos = ['pendiente', 'confirmada', 'cancelada', 'completada'];

      if (estado && !estadosValidos.includes(estado)) {
        return json({ error: `Estado inválido. Valores permitidos: ${estadosValidos.join(', ')}` }, 400);
      }

      const sets: string[] = [];
      const params: unknown[] = [];
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

      if (!sets.length) return json({ error: 'No hay campos para actualizar' }, 400);

      params.push(id);
      await query(`UPDATE reservas SET ${sets.join(', ')} WHERE id = $${idx}`, params);

      const result = await query(`SELECT * FROM reservas WHERE id = $1`, [id]);
      if (!result.rows.length) return json({ error: 'Reserva no encontrada' }, 404);

      if (estado === 'confirmada' || estado === 'cancelada') {
        await query(
          `UPDATE notificaciones_admin SET resuelta = TRUE, resuelta_en = NOW()
           WHERE reserva_id = $1 AND resuelta = FALSE`,
          [id]
        );
      }

      return json(result.rows[0]);
    }

    // ── DELETE /reservas/:id ──────────────────
    const deleteReservaMatch = path.match(/^\/reservas\/([^/]+)$/);
    if (method === 'DELETE' && deleteReservaMatch) {
      const id = deleteReservaMatch[1];
      const check = await query(`SELECT id FROM reservas WHERE id = $1`, [id]);
      if (!check.rows.length) return json({ error: 'Reserva no encontrada' }, 404);

      await query(`UPDATE reservas SET estado = 'cancelada' WHERE id = $1`, [id]);
      return json({ ok: true, id });
    }

    // ── GET /notificaciones ───────────────────
    if (method === 'GET' && path === '/notificaciones') {
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
      return json(result.rows);
    }

    // ── PATCH /notificaciones/:id/leida ───────
    const notifLeidaMatch = path.match(/^\/notificaciones\/(\d+)\/leida$/);
    if (method === 'PATCH' && notifLeidaMatch) {
      const id = notifLeidaMatch[1];
      await query(`UPDATE notificaciones_admin SET leida = TRUE WHERE id = $1`, [id]);
      return json({ ok: true });
    }

    // ── 404 ───────────────────────────────────
    return json({ error: `Ruta no encontrada: ${method} ${path}` }, 404);

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error interno del servidor';
    console.error(`[api] ${method} ${path}:`, message);
    return json({ error: message }, 500);
  }
}

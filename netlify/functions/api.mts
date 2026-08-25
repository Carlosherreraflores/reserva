import type { Config, Context } from '@netlify/functions';
import pg from 'pg';

const getEnv = (key: string) => {
  if (typeof Netlify !== 'undefined' && Netlify.env) {
    return Netlify.env.get(key) || process.env[key];
  }
  return process.env[key];
};

const dbUrl = getEnv('DATABASE_URL');
const dbHost = getEnv('DB_HOST');
const isLocal = !dbUrl && (dbHost === 'localhost' || dbHost === '127.0.0.1' || !dbHost);
const ssl = isLocal ? false : { rejectUnauthorized: false };

const pool = new pg.Pool({
  host: dbHost || 'localhost',
  user: getEnv('DB_USER'),
  password: getEnv('DB_PASSWORD'),
  database: getEnv('DB_NAME'),
  port: parseInt(getEnv('DB_PORT') || '5432'),
  max: 5,
  idleTimeoutMillis: 30000,
  ssl: ssl,
  ...(dbUrl && {
    connectionString: dbUrl,
  }),
});

async function query(text: string, params: any[] = []) {
  const result = await pool.query(text, params);
  return { rows: result.rows };
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  try {
    // GET /api/cabanas
    if (method === 'GET' && (pathname === '/api/cabanas' || pathname === '/api/cabanas/')) {
      const result = await query(
        `SELECT id, nombre, capacidad, hue, activa
         FROM cabanas
         WHERE activa = TRUE
         ORDER BY id`
      );
      return Response.json(result.rows);
    }

    // GET /api/reservas or /api/reservas/:id
    if (method === 'GET' && pathname.startsWith('/api/reservas')) {
      const idMatch = pathname.match(/^\/api\/reservas\/([^/]+)$/);
      if (idMatch) {
        const id = idMatch[1];
        const result = await query(
          `SELECT
             r.*,
             c.nombre AS "cabinName",
             c.hue    AS hue
           FROM reservas r
           JOIN cabanas c ON c.id = r.cabana_id
           WHERE r.id = $1`,
          [id]
        );
        if (!result.rows.length) {
          return Response.json({ error: 'Reserva no encontrada' }, { status: 404 });
        }
        return Response.json(result.rows[0]);
      }

      const estado = url.searchParams.get('estado');
      const estadosValidos = ['pendiente', 'confirmada', 'cancelada', 'completada'];

      let whereClause = `WHERE r.estado IN ('pendiente', 'confirmada')`;
      let params: any[] = [];

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
      return Response.json(result.rows);
    }

    // POST /api/reservas
    if (method === 'POST' && (pathname === '/api/reservas' || pathname === '/api/reservas/')) {
      const body = await req.json().catch(() => ({}));
      const { cabinId, checkIn, checkOut, guestName, phone, guests, notes } = body;

      if (!cabinId || !checkIn || !checkOut || !guestName || !phone) {
        return Response.json(
          { error: 'Faltan campos obligatorios: cabinId, checkIn, checkOut, guestName, phone' },
          { status: 400 }
        );
      }

      if (checkOut <= checkIn) {
        return Response.json(
          { error: 'La fecha de salida debe ser posterior a la de entrada' },
          { status: 400 }
        );
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
        return Response.json(
          { error: 'La cabaña ya tiene una reserva en esas fechas' },
          { status: 409 }
        );
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

      return Response.json(result.rows[0], { status: 201 });
    }

    // PATCH /api/reservas/:id
    if (method === 'PATCH' && pathname.startsWith('/api/reservas/')) {
      const idMatch = pathname.match(/^\/api\/reservas\/([^/]+)$/);
      if (!idMatch) {
        return Response.json({ error: 'Ruta no encontrada' }, { status: 404 });
      }
      const id = idMatch[1];
      const body = await req.json().catch(() => ({}));
      const { estado, confirmadaPor, notes } = body;
      const estadosValidos = ['pendiente', 'confirmada', 'cancelada', 'completada'];

      if (estado && !estadosValidos.includes(estado)) {
        return Response.json(
          { error: `Estado inválido. Valores permitidos: ${estadosValidos.join(', ')}` },
          { status: 400 }
        );
      }

      const sets: string[] = [];
      const params: any[] = [];
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

      if (!sets.length) {
        return Response.json({ error: 'No hay campos para actualizar' }, { status: 400 });
      }

      params.push(id);
      await query(
        `UPDATE reservas SET ${sets.join(', ')} WHERE id = $${idx}`,
        params
      );

      const result = await query(`SELECT * FROM reservas WHERE id = $1`, [id]);
      if (!result.rows.length) {
        return Response.json({ error: 'Reserva no encontrada' }, { status: 404 });
      }

      if (estado === 'confirmada' || estado === 'cancelada') {
        await query(
          `UPDATE notificaciones_admin SET resuelta = TRUE, resuelta_en = NOW()
           WHERE reserva_id = $1 AND resuelta = FALSE`,
          [id]
        );
      }

      return Response.json(result.rows[0]);
    }

    // DELETE /api/reservas/:id
    if (method === 'DELETE' && pathname.startsWith('/api/reservas/')) {
      const idMatch = pathname.match(/^\/api\/reservas\/([^/]+)$/);
      if (!idMatch) {
        return Response.json({ error: 'Ruta no encontrada' }, { status: 404 });
      }
      const id = idMatch[1];

      const check = await query(`SELECT id FROM reservas WHERE id = $1`, [id]);
      if (!check.rows.length) {
        return Response.json({ error: 'Reserva no encontrada' }, { status: 404 });
      }

      await query(`UPDATE reservas SET estado = 'cancelada' WHERE id = $1`, [id]);
      return Response.json({ ok: true, id });
    }

    // GET /api/notificaciones
    if (method === 'GET' && (pathname === '/api/notificaciones' || pathname === '/api/notificaciones/')) {
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
      return Response.json(result.rows);
    }

    // PATCH /api/notificaciones/:id/leida
    if (method === 'PATCH' && pathname.startsWith('/api/notificaciones/')) {
      const match = pathname.match(/^\/api\/notificaciones\/([^/]+)\/leida$/);
      if (match) {
        const id = match[1];
        await query(
          `UPDATE notificaciones_admin SET leida = TRUE WHERE id = $1`,
          [id]
        );
        return Response.json({ ok: true });
      }
    }

    return Response.json({ error: 'Endpoint no encontrado' }, { status: 404 });
  } catch (err: any) {
    console.error('API Error:', err.message);
    return Response.json({ error: err.message || 'Error interno del servidor' }, { status: 500 });
  }
};

export const config: Config = {
  path: '/api/*',
};

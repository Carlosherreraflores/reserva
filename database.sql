-- ============================================================
--  Cabañas Guanaquero — Script de base de datos PostgreSQL
--  Crea: base de datos, usuario, tablas e índices
-- ============================================================

-- ============================================================
-- 1. USUARIO Y BASE DE DATOS
--    Ejecutar como superusuario (ej: postgres)
-- ============================================================

-- Crear el usuario de la aplicación
CREATE USER cabanas_user WITH
  PASSWORD '563o6SaX0Gpk6pNFR.,!'   -- ← cambia esta contraseña
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  LOGIN;

-- Crear la base de datos
CREATE DATABASE cabanas_guanaquero
  OWNER = cabanas_user
  ENCODING = 'UTF8'
  LC_COLLATE = 'es_ES.UTF-8'
  LC_CTYPE  = 'es_ES.UTF-8'
  TEMPLATE = template0;

-- Conectarse a la nueva base de datos antes de continuar:
-- \c cabanas_guanaquero

-- ============================================================
-- 2. TABLA: cabanas
--    Almacena las 8 cabañas con su capacidad y color (hue)
-- ============================================================

CREATE TABLE IF NOT EXISTS cabanas (
  id        SERIAL        PRIMARY KEY,
  nombre    VARCHAR(100)  NOT NULL,
  capacidad SMALLINT      NOT NULL CHECK (capacidad > 0),
  hue       SMALLINT      NOT NULL DEFAULT 145,  -- tono HSL para la UI
  activa    BOOLEAN       NOT NULL DEFAULT TRUE,
  creado_en TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  cabanas             IS 'Registro de cabañas disponibles para reserva';
COMMENT ON COLUMN cabanas.hue         IS 'Tono HSL usado en la interfaz gráfica (0-360)';
COMMENT ON COLUMN cabanas.activa      IS 'FALSE oculta la cabaña sin borrarla';

-- ============================================================
-- 3. TABLA: reservas
--    Cada fila es una reserva de una cabaña para un huésped
-- ============================================================

CREATE TABLE IF NOT EXISTS reservas (
  id              VARCHAR(30)   PRIMARY KEY,          -- ID generado en el cliente (rXXXXXX)
  cabana_id       INTEGER       NOT NULL REFERENCES cabanas(id) ON DELETE RESTRICT,
  check_in        DATE          NOT NULL,
  check_out       DATE          NOT NULL,
  nombre_huesped  VARCHAR(200)  NOT NULL,
  telefono        VARCHAR(30)   NOT NULL,
  whatsapp_jid    VARCHAR(100),                       -- JID del contacto en WhatsApp (ej: 56912345678@s.whatsapp.net)
  personas        SMALLINT      NOT NULL DEFAULT 1 CHECK (personas >= 1 AND personas <= 20),
  notas           TEXT,
  origen          VARCHAR(20)   NOT NULL DEFAULT 'web'
                                CHECK (origen IN ('web', 'whatsapp', 'telefono', 'presencial')),
  estado          VARCHAR(20)   NOT NULL DEFAULT 'pendiente'
                                CHECK (estado IN ('pendiente', 'confirmada', 'cancelada', 'completada')),
  confirmada_por  VARCHAR(100),                       -- Nombre o ID del admin que confirmó
  confirmada_en   TIMESTAMPTZ,                        -- Fecha/hora de la confirmación
  creado_en       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  actualizado_en  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- Las fechas deben ser coherentes
  CONSTRAINT ck_fechas_validas CHECK (check_out > check_in)
);

COMMENT ON TABLE  reservas                    IS 'Reservas de cabañas por huéspedes';
COMMENT ON COLUMN reservas.id                 IS 'ID alfanumérico generado por la aplicación cliente';
COMMENT ON COLUMN reservas.check_in           IS 'Fecha de llegada (inclusive)';
COMMENT ON COLUMN reservas.check_out          IS 'Fecha de salida (exclusiva, el huésped sale ese día)';
COMMENT ON COLUMN reservas.whatsapp_jid       IS 'Identificador JID de WhatsApp del huésped; NULL si la reserva no vino por el bot';
COMMENT ON COLUMN reservas.origen             IS 'Canal por el que se originó la reserva: web | whatsapp | telefono | presencial';
COMMENT ON COLUMN reservas.estado             IS 'pendiente (esperando confirmación admin) | confirmada | cancelada | completada';
COMMENT ON COLUMN reservas.confirmada_por     IS 'Usuario administrador que aprobó la reserva';
COMMENT ON COLUMN reservas.confirmada_en      IS 'Timestamp en que el admin confirmó la reserva';

-- ============================================================
-- 4. ÍNDICES
-- ============================================================

-- Búsquedas frecuentes por cabaña y rango de fechas (solo reservas confirmadas)
CREATE INDEX IF NOT EXISTS idx_reservas_cabana_fechas
  ON reservas (cabana_id, check_in, check_out)
  WHERE estado = 'confirmada';

-- Reservas pendientes de confirmación por el admin
CREATE INDEX IF NOT EXISTS idx_reservas_pendientes
  ON reservas (estado, creado_en)
  WHERE estado = 'pendiente';

-- Buscar todas las reservas de un contacto de WhatsApp
CREATE INDEX IF NOT EXISTS idx_reservas_whatsapp_jid
  ON reservas (whatsapp_jid)
  WHERE whatsapp_jid IS NOT NULL;

-- Búsqueda por nombre de huésped
CREATE INDEX IF NOT EXISTS idx_reservas_huesped
  ON reservas (LOWER(nombre_huesped));

-- Búsqueda por teléfono
CREATE INDEX IF NOT EXISTS idx_reservas_telefono
  ON reservas (telefono);

-- ============================================================
-- 5. FUNCIÓN Y TRIGGER: evitar reservas solapadas
--    Garantiza que una cabaña no tenga dos reservas activas
--    para el mismo rango de fechas.
-- ============================================================

CREATE OR REPLACE FUNCTION fn_verificar_solapamiento()
RETURNS TRIGGER AS $$
BEGIN
  -- Solo bloquear solapamiento entre reservas confirmadas
  -- Las pendientes se verifican al momento de confirmar
  IF NEW.estado = 'confirmada' AND EXISTS (
    SELECT 1 FROM reservas
    WHERE  cabana_id  = NEW.cabana_id
      AND  estado     = 'confirmada'
      AND  id        <> NEW.id
      AND  check_in  < NEW.check_out
      AND  check_out > NEW.check_in
  ) THEN
    RAISE EXCEPTION
      'La cabaña % ya tiene una reserva confirmada que se solapa con las fechas % → %',
      NEW.cabana_id, NEW.check_in, NEW.check_out;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_solapamiento_reservas
  BEFORE INSERT OR UPDATE ON reservas
  FOR EACH ROW EXECUTE FUNCTION fn_verificar_solapamiento();

-- ============================================================
-- 6. TRIGGER: actualizar "actualizado_en" automáticamente
-- ============================================================

CREATE OR REPLACE FUNCTION fn_set_actualizado_en()
RETURNS TRIGGER AS $$
BEGIN
  NEW.actualizado_en = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_actualizado_en_reservas
  BEFORE UPDATE ON reservas
  FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();

-- ============================================================
-- 7. TABLAS DEL BOT DE WHATSAPP
-- ============================================================

-- ---------------------------------------------------------------
-- 7a. TABLA: conversaciones_bot
--     Historial de mensajes por contacto de WhatsApp.
--     Permite que la IA tenga contexto de la conversación.
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversaciones_bot (
  id            BIGSERIAL     PRIMARY KEY,
  whatsapp_jid  VARCHAR(100)  NOT NULL,               -- JID del contacto (ej: 56912345678@s.whatsapp.net)
  rol           VARCHAR(10)   NOT NULL CHECK (rol IN ('user', 'assistant')),
  mensaje       TEXT          NOT NULL,
  reserva_id    VARCHAR(30)   REFERENCES reservas(id) ON DELETE SET NULL,  -- reserva asociada si la hay
  creado_en     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  conversaciones_bot             IS 'Historial de mensajes intercambiados con el bot de WhatsApp';
COMMENT ON COLUMN conversaciones_bot.whatsapp_jid IS 'Identificador único del contacto en WhatsApp';
COMMENT ON COLUMN conversaciones_bot.rol          IS 'user = mensaje del cliente; assistant = respuesta del bot';
COMMENT ON COLUMN conversaciones_bot.reserva_id   IS 'Reserva que se gestionó en este mensaje, si aplica';

CREATE INDEX IF NOT EXISTS idx_conversaciones_jid_fecha
  ON conversaciones_bot (whatsapp_jid, creado_en DESC);

-- ---------------------------------------------------------------
-- 7b. TABLA: notificaciones_admin
--     Cola de eventos que el administrador debe revisar/aprobar.
--     El bot inserta aquí cuando un cliente solicita una reserva.
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notificaciones_admin (
  id            BIGSERIAL     PRIMARY KEY,
  tipo          VARCHAR(30)   NOT NULL
                              CHECK (tipo IN ('nueva_reserva', 'cancelacion', 'consulta', 'otro')),
  reserva_id    VARCHAR(30)   REFERENCES reservas(id) ON DELETE CASCADE,
  whatsapp_jid  VARCHAR(100),                         -- contacto que originó la notificación
  mensaje       TEXT          NOT NULL,               -- resumen legible para el admin
  leida         BOOLEAN       NOT NULL DEFAULT FALSE,
  resuelta      BOOLEAN       NOT NULL DEFAULT FALSE,
  creado_en     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  resuelta_en   TIMESTAMPTZ
);

COMMENT ON TABLE  notificaciones_admin           IS 'Cola de notificaciones para el administrador generadas por el bot';
COMMENT ON COLUMN notificaciones_admin.tipo       IS 'Categoría del evento: nueva_reserva | cancelacion | consulta | otro';
COMMENT ON COLUMN notificaciones_admin.leida      IS 'El admin vio la notificación';
COMMENT ON COLUMN notificaciones_admin.resuelta   IS 'El admin tomó acción (confirmó, rechazó, respondió)';

CREATE INDEX IF NOT EXISTS idx_notificaciones_pendientes
  ON notificaciones_admin (resuelta, creado_en DESC)
  WHERE resuelta = FALSE;

-- ---------------------------------------------------------------
-- 7c. TABLA: sesiones_bot
--     Estado actual de la conversación de cada usuario con el bot.
--     Permite retomar el flujo de reserva donde quedó.
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sesiones_bot (
  whatsapp_jid  VARCHAR(100)  PRIMARY KEY,
  etapa         VARCHAR(50)   NOT NULL DEFAULT 'inicio',
                                        -- inicio | seleccion_fecha | seleccion_cabana |
                                        -- confirmacion_datos | esperando_confirmacion_admin | finalizada
  datos_temp    JSONB,                  -- datos del formulario de reserva en curso (check_in, check_out, personas, etc.)
  reserva_id    VARCHAR(30)   REFERENCES reservas(id) ON DELETE SET NULL,
  actualizado_en TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  sesiones_bot             IS 'Estado del flujo de conversación de cada contacto con el bot';
COMMENT ON COLUMN sesiones_bot.etapa       IS 'Paso actual del flujo de reserva por WhatsApp';
COMMENT ON COLUMN sesiones_bot.datos_temp  IS 'JSON con los datos parciales de la reserva en construcción';

-- ============================================================
-- 8. DATOS INICIALES: las 8 cabañas
-- ============================================================

INSERT INTO cabanas (nombre, capacidad, hue) VALUES
  ('Cabaña 1', 4, 145),
  ('Cabaña 2', 6,  25),
  ('Cabaña 3', 4, 205),
  ('Cabaña 4', 8, 265),
  ('Cabaña 5', 6, 330),
  ('Cabaña 6', 4,  45),
  ('Cabaña 7', 6, 180),
  ('Cabaña 8', 8,  10)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 9. PERMISOS DEL USUARIO DE APLICACIÓN
-- ============================================================

GRANT CONNECT ON DATABASE cabanas_guanaquero TO cabanas_user;
GRANT USAGE   ON SCHEMA public              TO cabanas_user;

-- Tablas existentes
GRANT SELECT, INSERT, UPDATE, DELETE ON cabanas  TO cabanas_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON reservas TO cabanas_user;

-- Tablas del bot
GRANT SELECT, INSERT, UPDATE, DELETE ON conversaciones_bot    TO cabanas_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON notificaciones_admin  TO cabanas_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON sesiones_bot          TO cabanas_user;

-- Secuencias (necesario para SERIAL/BIGSERIAL)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cabanas_user;

-- ============================================================
-- FIN DEL SCRIPT
-- ============================================================

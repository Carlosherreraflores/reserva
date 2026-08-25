-- ============================================================
--  Cabañas Guanaquero — Script de base de datos MySQL (8.0+)
--  Crea: tablas, índices, llaves foráneas y datos iniciales
-- ============================================================

-- Descomenta si deseas asegurar la base de datos a usar:
-- USE cabanas_guanaquero;

-- ------------------------------------------------------------
-- 1. TABLA: cabanas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cabanas (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  nombre      VARCHAR(100) NOT NULL,
  capacidad   SMALLINT NOT NULL,
  hue         SMALLINT NOT NULL DEFAULT 145,
  activa      BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_cabanas_capacidad CHECK (capacidad > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 2. TABLA: reservas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservas (
  id              VARCHAR(30) PRIMARY KEY,
  cabana_id       INT NOT NULL,
  check_in        DATE NOT NULL,
  check_out       DATE NOT NULL,
  nombre_huesped  VARCHAR(200) NOT NULL,
  telefono        VARCHAR(30) NOT NULL,
  whatsapp_jid    VARCHAR(100) NULL,
  personas        SMALLINT NOT NULL DEFAULT 1,
  notas           TEXT NULL,
  origen          ENUM('web', 'whatsapp', 'telefono', 'presencial') NOT NULL DEFAULT 'web',
  estado          ENUM('pendiente', 'confirmada', 'cancelada', 'completada') NOT NULL DEFAULT 'pendiente',
  confirmada_por  VARCHAR(100) NULL,
  confirmada_en   DATETIME NULL,
  creado_en       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_reservas_cabana FOREIGN KEY (cabana_id) REFERENCES cabanas(id) ON DELETE RESTRICT,
  CONSTRAINT ck_reservas_fechas CHECK (check_out > check_in),
  CONSTRAINT ck_reservas_personas CHECK (personas >= 1 AND personas <= 20)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Índices en reservas
CREATE INDEX idx_reservas_cabana_fechas ON reservas (cabana_id, check_in, check_out, estado);
CREATE INDEX idx_reservas_pendientes ON reservas (estado, creado_en);
CREATE INDEX idx_reservas_whatsapp_jid ON reservas (whatsapp_jid);
CREATE INDEX idx_reservas_telefono ON reservas (telefono);
CREATE INDEX idx_reservas_huesped ON reservas (nombre_huesped);

-- ------------------------------------------------------------
-- 3. TABLA: conversaciones_bot
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversaciones_bot (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  whatsapp_jid  VARCHAR(100) NOT NULL,
  rol           ENUM('user', 'assistant') NOT NULL,
  mensaje       TEXT NOT NULL,
  reserva_id    VARCHAR(30) NULL,
  creado_en     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_conversaciones_reserva FOREIGN KEY (reserva_id) REFERENCES reservas(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_conversaciones_jid_fecha ON conversaciones_bot (whatsapp_jid, creado_en DESC);

-- ------------------------------------------------------------
-- 4. TABLA: notificaciones_admin
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notificaciones_admin (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  tipo          ENUM('nueva_reserva', 'cancelacion', 'consulta', 'otro') NOT NULL,
  reserva_id    VARCHAR(30) NULL,
  whatsapp_jid  VARCHAR(100) NULL,
  mensaje       TEXT NOT NULL,
  leida         BOOLEAN NOT NULL DEFAULT FALSE,
  resuelta      BOOLEAN NOT NULL DEFAULT FALSE,
  creado_en     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resuelta_en   DATETIME NULL,

  CONSTRAINT fk_notificaciones_reserva FOREIGN KEY (reserva_id) REFERENCES reservas(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_notificaciones_pendientes ON notificaciones_admin (resuelta, creado_en DESC);

-- ------------------------------------------------------------
-- 5. TABLA: sesiones_bot
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sesiones_bot (
  whatsapp_jid    VARCHAR(100) PRIMARY KEY,
  etapa           VARCHAR(50) NOT NULL DEFAULT 'inicio',
  datos_temp      JSON NULL,
  reserva_id      VARCHAR(30) NULL,
  actualizado_en  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_sesiones_reserva FOREIGN KEY (reserva_id) REFERENCES reservas(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 6. DATOS INICIALES: Las 8 cabañas
-- ------------------------------------------------------------
INSERT INTO cabanas (id, nombre, capacidad, hue) VALUES
  (1, 'Cabaña 1', 4, 145),
  (2, 'Cabaña 2', 6,  25),
  (3, 'Cabaña 3', 4, 205),
  (4, 'Cabaña 4', 8, 265),
  (5, 'Cabaña 5', 6, 330),
  (6, 'Cabaña 6', 4,  45),
  (7, 'Cabaña 7', 6, 180),
  (8, 'Cabaña 8', 8,  10)
ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), capacidad = VALUES(capacidad), hue = VALUES(hue);


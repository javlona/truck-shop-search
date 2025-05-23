-- PostgreSQL schema for Telegram Service Shop Bot

-- Table to store service shop details
CREATE TABLE IF NOT EXISTS shops (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    street TEXT,
    city TEXT,
    state TEXT,
    zip VARCHAR(10),
    type TEXT,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION
);

-- Table to cache ZIP code to coordinates mapping
CREATE TABLE IF NOT EXISTS zips (
    zip VARCHAR(10) PRIMARY KEY,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION
);

-- Extension for earthdistance (optional)
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS cube;
  CREATE EXTENSION IF NOT EXISTS earthdistance;
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;

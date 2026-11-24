-- Выполняется один раз при первом старте пустого тома postgres.
-- Отдельные базы: litellm (ключи, spend logs шлюза) и burmalda (память, сессии, задачи).
CREATE DATABASE litellm;
CREATE DATABASE burmalda;

\connect burmalda
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

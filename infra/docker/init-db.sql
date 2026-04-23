-- Create companion test database alongside the main one on first boot.
SELECT 'CREATE DATABASE vibe_connect_test OWNER vibe'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'vibe_connect_test')\gexec

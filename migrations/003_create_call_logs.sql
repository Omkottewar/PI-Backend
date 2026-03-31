-- create_call_logs.sql
CREATE TABLE IF NOT EXISTS call_logs (
  id SERIAL PRIMARY KEY,
  caller_number VARCHAR(20),
  receiver_number VARCHAR(20),
  call_uuid VARCHAR(100),
  status VARCHAR(50),
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  duration INT
);

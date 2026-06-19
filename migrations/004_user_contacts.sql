-- user_contacts.sql
CREATE TABLE IF NOT EXISTS user_contacts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  relation VARCHAR(50) NOT NULL,
  CONSTRAINT unique_user_phone UNIQUE (user_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_user_contacts_user_id ON user_contacts(user_id);

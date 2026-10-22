-- Sample "shop" database for trying pgAdmin+.
-- It intentionally contains a few problems the Insights panel should detect:
--   * orders.customer_id and order_items.product_id are foreign keys without indexes
--   * event_log has no primary key
--   * products has a duplicate index
--
--   docker run -d --name pgplus-sample -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16
--   docker exec -i pgplus-sample psql -U postgres < scripts/seed_sample.sql
-- Then add a connection: host.docker.internal : 5433, db "shop", user/pass postgres/postgres.

DROP DATABASE IF EXISTS shop;
CREATE DATABASE shop;
\connect shop

CREATE TABLE customers (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email       text NOT NULL UNIQUE,
    full_name   text NOT NULL,
    country     text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sku         text NOT NULL,
    name        text NOT NULL,
    category    text NOT NULL,
    price       numeric(10, 2) NOT NULL CHECK (price >= 0)
);
CREATE INDEX products_sku_idx ON products (sku);
CREATE INDEX products_sku_idx2 ON products (sku);  -- duplicate on purpose

CREATE TABLE orders (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id  bigint NOT NULL REFERENCES customers (id),  -- no index on purpose
    status       text NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled')),
    ordered_at   timestamptz NOT NULL
);

CREATE TABLE order_items (
    order_id    bigint NOT NULL REFERENCES orders (id),
    product_id  bigint NOT NULL REFERENCES products (id),  -- no index on purpose
    quantity    int NOT NULL CHECK (quantity > 0),
    unit_price  numeric(10, 2) NOT NULL,
    PRIMARY KEY (order_id, product_id)
);

CREATE TABLE event_log (  -- no primary key on purpose
    happened_at timestamptz NOT NULL DEFAULT now(),
    kind        text NOT NULL,
    payload     jsonb
);

INSERT INTO customers (email, full_name, country, created_at)
SELECT 'user' || g || '@example.com',
       'Customer ' || g,
       (ARRAY['US', 'IN', 'DE', 'GB', 'FR', 'BR', 'JP', 'CA'])[1 + g % 8],
       now() - (g % 900) * interval '1 day'
FROM generate_series(1, 5000) g;

INSERT INTO products (sku, name, category, price)
SELECT 'SKU-' || lpad(g::text, 5, '0'),
       'Product ' || g,
       (ARRAY['books', 'electronics', 'garden', 'toys', 'grocery'])[1 + g % 5],
       round((5 + random() * 495)::numeric, 2)
FROM generate_series(1, 500) g;

INSERT INTO orders (customer_id, status, ordered_at)
SELECT 1 + (random() * 4999)::int,
       (ARRAY['pending', 'paid', 'shipped', 'cancelled'])[1 + (random() * 3)::int],
       now() - random() * interval '730 days'
FROM generate_series(1, 40000);

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT o.id, p.id, 1 + (random() * 4)::int, p.price
FROM orders o
CROSS JOIN LATERAL (
    SELECT id, price FROM products
    WHERE id IN (1 + (o.id * 7) % 500, 1 + (o.id * 13) % 500, 1 + (o.id * 31) % 500)
) p;

INSERT INTO event_log (happened_at, kind, payload)
SELECT now() - g * interval '1 minute',
       (ARRAY['login', 'checkout', 'search', 'logout'])[1 + g % 4],
       jsonb_build_object('session', md5(g::text))
FROM generate_series(1, 20000) g;

ANALYZE;

-- Fonlok Integration — Orders Table Migration
-- Run this once against the Njimbong PostgreSQL database on Railway.

CREATE TABLE IF NOT EXISTS public.orders (
    id               SERIAL PRIMARY KEY,
    listing_id       INTEGER NOT NULL REFERENCES userlistings(id),
    buyer_id         INTEGER NOT NULL REFERENCES users(id),
    seller_id        INTEGER NOT NULL REFERENCES users(id),
    amount           NUMERIC(12, 2) NOT NULL,
    currency         VARCHAR(10)  NOT NULL DEFAULT 'XAF',
    order_reference  VARCHAR(200) NOT NULL UNIQUE,

    -- Fonlok escrow fields
    fonlok_invoice_id   VARCHAR(100),
    fonlok_reference    UUID,
    fonlok_payment_url  TEXT,
    fonlok_status       VARCHAR(30) NOT NULL DEFAULT 'none',

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT orders_fonlok_status_check CHECK (
        fonlok_status IN (
            'none',             -- order record created, invoice not yet created
            'pending',          -- MoMo prompt sent, awaiting buyer approval
            'paid_in_escrow',   -- buyer approved, funds held by Fonlok
            'released',         -- buyer confirmed receipt, seller paid out
            'disputed',         -- dispute opened on Fonlok
            'failed',           -- buyer rejected or MoMo timeout
            'cancelled',        -- order cancelled
            'initiation_failed' -- POST /v1/payments/initiate failed; can retry
        )
    )
);

CREATE INDEX IF NOT EXISTS orders_buyer_id_idx         ON public.orders (buyer_id);
CREATE INDEX IF NOT EXISTS orders_seller_id_idx        ON public.orders (seller_id);
CREATE INDEX IF NOT EXISTS orders_listing_id_idx       ON public.orders (listing_id);
CREATE INDEX IF NOT EXISTS orders_fonlok_invoice_id_idx ON public.orders (fonlok_invoice_id);
CREATE INDEX IF NOT EXISTS orders_fonlok_reference_idx ON public.orders (fonlok_reference);

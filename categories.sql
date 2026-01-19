--
-- PostgreSQL database dump
--

-- Dumped from database version 15.4
-- Dumped by pg_dump version 15.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;
SET session_replication_role = replica;

--
-- Data for Name: categories; Type: TABLE DATA; Schema: public; Owner: postgres
--

INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (2, 'Vehicles', 'vehicles', NULL, 'Cars, motorcycles, bicycles, and vehicle parts', '🚗', NULL, 0, '2025-12-03 14:04:21.307512+01');
INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (3, 'Property', 'property', NULL, 'Houses, apartments, land, and commercial spaces for sale or rent', '🏠', NULL, 0, '2025-12-03 14:04:21.32609+01');
INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (4, 'Fashion & Clothing', 'fashion', NULL, 'Mens, womens, and childrens clothing, shoes, and accessories', '👔', NULL, 0, '2025-12-03 14:04:21.331832+01');
INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (5, 'Home & Garden', 'home-garden', NULL, 'Furniture, appliances, decor, and gardening equipment', '🛋️', NULL, 0, '2025-12-03 14:04:21.336426+01');
INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (6, 'Health & Beauty', 'health-beauty', NULL, 'Cosmetics, skincare, health products, and personal care', '💄', NULL, 0, '2025-12-03 14:04:21.343076+01');
INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (7, 'Sports & Outdoors', 'sports-outdoors', NULL, 'Sports equipment, fitness gear, camping, and outdoor activities', '⚽', NULL, 0, '2025-12-03 14:04:21.347787+01');
INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (8, 'Jobs', 'jobs', NULL, 'Job listings and employment opportunities', '💼', NULL, 0, '2025-12-03 14:04:21.35421+01');
INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (9, 'Services', 'services', NULL, 'Professional services, repairs, freelancing, and contractors', '🔧', NULL, 0, '2025-12-03 14:04:21.362174+01');
INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (10, 'Education', 'education', NULL, 'Books, courses, tutoring, and educational materials', '📚', NULL, 0, '2025-12-03 14:04:21.368798+01');
INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (11, 'Pets & Animals', 'pets', NULL, 'Pets, livestock, pet supplies, and animal services', '🐾', NULL, 0, '2025-12-03 14:04:21.377405+01');
INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (12, 'Food & Agriculture', 'food-agriculture', NULL, 'Farm produce, food products, and agricultural equipment', '🌾', NULL, 0, '2025-12-03 14:04:21.381259+01');
INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (13, 'Baby & Kids', 'baby-kids', NULL, 'Baby items, toys, childrens furniture, and kids essentials', '👶', NULL, 0, '2025-12-03 14:04:21.385211+01');
INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (14, 'Entertainment', 'entertainment', NULL, 'Gaming, music, movies, events, and tickets', '🎮', NULL, 0, '2025-12-03 14:04:21.39183+01');
INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (15, 'Business & Industrial', 'business-industrial', NULL, 'Office equipment, machinery, wholesale, and business supplies', '🏭', NULL, 0, '2025-12-03 14:04:21.395834+01');
INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (16, 'Art & Collectibles', 'art-collectibles', NULL, 'Artwork, antiques, collectibles, and handmade crafts', '🎨', NULL, 0, '2025-12-03 14:04:21.400339+01');
INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (17, 'Travel & Tourism', 'travel', NULL, 'Travel packages, accommodations, and tourism services', '✈️', NULL, 0, '2025-12-03 14:04:21.408877+01');
INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (18, 'Other', 'other', NULL, 'Items that do not fit other categories', '📦', NULL, 0, '2025-12-03 14:04:21.412635+01');
INSERT INTO public.categories (id, name, slug, parentid, description, icon, imageurl, sortoder, createdat) VALUES (1, 'Electronics', 'electronics', NULL, 'Discover a wide range of cutting-edge gadgets and essential tech devices. From smartphones, laptops, and tablets to TVs, audio systems, gaming consoles, and smart home devices, this category brings together the latest innovations designed to make life easier, faster, and more connected. Whether you’re upgrading your gear or looking for reliable accessories, you’ll find quality electronics from trusted brands and verified sellers.', '📱', NULL, 0, '2025-11-27 14:22:56.975715+01');

SELECT pg_catalog.setval('public.categories_id_seq', (SELECT MAX(id) FROM public.categories), true);
SET session_replication_role = origin;


--
-- Name: categories_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.categories_id_seq', 18, true);


--
-- PostgreSQL database dump complete
--


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

--
-- Name: calculate_trust_score(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.calculate_trust_score(p_user_id integer) RETURNS TABLE(total_score integer, breakdown jsonb)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_score INTEGER := 0;
    v_breakdown JSONB := '{}'::jsonb;
    v_user RECORD;
    v_review_stats RECORD;
    v_listing_count INTEGER;
    v_report_count INTEGER;
    v_rejection_count INTEGER;
    v_suspension_count INTEGER;
    v_warning_points INTEGER;
    v_months_as_member INTEGER;
    v_profile_complete BOOLEAN;
    v_review_score DECIMAL;
BEGIN
    -- Get user data
    SELECT 
        u.*,
        EXTRACT(MONTH FROM AGE(NOW(), u.createdat))::INTEGER +
        (EXTRACT(YEAR FROM AGE(NOW(), u.createdat))::INTEGER * 12) as months_member
    INTO v_user
    FROM users u
    WHERE u.id = p_user_id;
    
    IF NOT FOUND THEN
        RETURN QUERY SELECT 0, '{}'::jsonb;
        RETURN;
    END IF;
    
    v_months_as_member := COALESCE(v_user.months_member, 0);
    
    -- ========================================
    -- POSITIVE FACTORS
    -- ========================================
    
    -- 1. KYC Verification (+15 points)
    IF v_user.kyc_status = 'approved' THEN
        v_score := v_score + 15;
        v_breakdown := v_breakdown || jsonb_build_object('kyc_verified', jsonb_build_object(
            'points', 15,
            'status', 'approved',
            'description', 'Identity verified through KYC'
        ));
    ELSE
        v_breakdown := v_breakdown || jsonb_build_object('kyc_verified', jsonb_build_object(
            'points', 0,
            'status', v_user.kyc_status,
            'description', 'KYC verification pending or not submitted'
        ));
    END IF;
    
    -- 2. Account Age 3+ months (+10 points)
    IF v_months_as_member >= 3 THEN
        v_score := v_score + 10;
        v_breakdown := v_breakdown || jsonb_build_object('account_age_3mo', jsonb_build_object(
            'points', 10,
            'months', v_months_as_member,
            'description', 'Account is 3+ months old'
        ));
    ELSE
        v_breakdown := v_breakdown || jsonb_build_object('account_age_3mo', jsonb_build_object(
            'points', 0,
            'months', v_months_as_member,
            'description', 'Account needs to be 3+ months old'
        ));
    END IF;
    
    -- 3. Account Age 12+ months (+10 points bonus)
    IF v_months_as_member >= 12 THEN
        v_score := v_score + 10;
        v_breakdown := v_breakdown || jsonb_build_object('account_age_12mo', jsonb_build_object(
            'points', 10,
            'months', v_months_as_member,
            'description', 'Trusted long-term member (12+ months)'
        ));
    ELSE
        v_breakdown := v_breakdown || jsonb_build_object('account_age_12mo', jsonb_build_object(
            'points', 0,
            'months', v_months_as_member,
            'description', 'Bonus for 12+ months membership'
        ));
    END IF;
    
    -- 4. Verified Reviews (+5 points max)
    -- Only count reviews from KYC-verified reviewers
    SELECT 
        COUNT(*) as total_count,
        COALESCE(AVG(rating), 0) as avg_rating,
        COUNT(*) FILTER (WHERE rating >= 4) as positive_count,
        COUNT(*) FILTER (WHERE rating <= 2) as negative_count
    INTO v_review_stats
    FROM user_reviews r
    JOIN users reviewer ON reviewer.id = r.reviewer_id
    WHERE r.reviewed_user_id = p_user_id
      AND r.is_valid = true
      AND r.is_verified = true
      AND reviewer.kyc_status = 'approved';  -- Only KYC-verified reviewers count
    
    -- Calculate review score (max 5 points)
    -- Formula: (avg_rating / 5) * min(review_count, 10) / 10 * 5
    -- This means: need 10+ reviews with 5-star average to get full 5 points
    IF v_review_stats.total_count > 0 THEN
        v_review_score := LEAST(
            5,
            (v_review_stats.avg_rating / 5.0) * LEAST(v_review_stats.total_count, 10) / 10.0 * 5
        );
        v_score := v_score + v_review_score::INTEGER;
        v_breakdown := v_breakdown || jsonb_build_object('verified_reviews', jsonb_build_object(
            'points', v_review_score::INTEGER,
            'max_points', 5,
            'total_reviews', v_review_stats.total_count,
            'average_rating', ROUND(v_review_stats.avg_rating, 2),
            'positive_reviews', v_review_stats.positive_count,
            'negative_reviews', v_review_stats.negative_count,
            'description', 'Reviews from verified buyers'
        ));
    ELSE
        v_breakdown := v_breakdown || jsonb_build_object('verified_reviews', jsonb_build_object(
            'points', 0,
            'max_points', 5,
            'total_reviews', 0,
            'description', 'No verified reviews yet'
        ));
    END IF;
    
    -- 5. Active Listings 10+ (+5 points)
    SELECT COUNT(*) INTO v_listing_count
    FROM listings
    WHERE user_id = p_user_id 
      AND status = 'active'
      AND moderation_status = 'approved';
    
    IF v_listing_count >= 10 THEN
        v_score := v_score + 5;
        v_breakdown := v_breakdown || jsonb_build_object('active_listings', jsonb_build_object(
            'points', 5,
            'count', v_listing_count,
            'required', 10,
            'description', 'Active seller with 10+ approved listings'
        ));
    ELSE
        v_breakdown := v_breakdown || jsonb_build_object('active_listings', jsonb_build_object(
            'points', 0,
            'count', v_listing_count,
            'required', 10,
            'description', 'Need 10+ active approved listings'
        ));
    END IF;
    
    -- 6. Complete Profile (+5 points)
    v_profile_complete := (
        v_user.name IS NOT NULL AND v_user.name != '' AND
        v_user.profilepicture IS NOT NULL AND
        v_user.country IS NOT NULL AND
        v_user.phone IS NOT NULL AND
        v_user.bio IS NOT NULL AND v_user.bio != ''
    );
    
    IF v_profile_complete THEN
        v_score := v_score + 5;
        v_breakdown := v_breakdown || jsonb_build_object('complete_profile', jsonb_build_object(
            'points', 5,
            'is_complete', true,
            'description', 'Profile fully completed'
        ));
    ELSE
        v_breakdown := v_breakdown || jsonb_build_object('complete_profile', jsonb_build_object(
            'points', 0,
            'is_complete', false,
            'description', 'Complete your profile (name, photo, country, phone, bio)'
        ));
    END IF;
    
    -- ========================================
    -- NEGATIVE FACTORS
    -- ========================================
    
    -- 7. Verified Reports (-5 each, max -20)
    SELECT COUNT(*) INTO v_report_count
    FROM reports
    WHERE reported_user_id = p_user_id
      AND status = 'verified';
    
    IF v_report_count > 0 THEN
        v_score := v_score - LEAST(v_report_count * 5, 20);
        v_breakdown := v_breakdown || jsonb_build_object('verified_reports', jsonb_build_object(
            'points', -LEAST(v_report_count * 5, 20),
            'count', v_report_count,
            'per_report', -5,
            'max_penalty', -20,
            'description', 'Verified reports against this user'
        ));
    END IF;
    
    -- 8. Rejected Listings (-3 each, max -15)
    SELECT COUNT(*) INTO v_rejection_count
    FROM listings
    WHERE user_id = p_user_id
      AND moderation_status = 'rejected';
    
    IF v_rejection_count > 0 THEN
        v_score := v_score - LEAST(v_rejection_count * 3, 15);
        v_breakdown := v_breakdown || jsonb_build_object('rejected_listings', jsonb_build_object(
            'points', -LEAST(v_rejection_count * 3, 15),
            'count', v_rejection_count,
            'per_rejection', -3,
            'max_penalty', -15,
            'description', 'Listings rejected by moderation'
        ));
    END IF;
    
    -- 9. Suspensions (-25 each)
    SELECT COUNT(*) INTO v_suspension_count
    FROM user_suspensions
    WHERE user_id = p_user_id;
    
    IF v_suspension_count > 0 THEN
        v_score := v_score - (v_suspension_count * 25);
        v_breakdown := v_breakdown || jsonb_build_object('suspensions', jsonb_build_object(
            'points', -(v_suspension_count * 25),
            'count', v_suspension_count,
            'per_suspension', -25,
            'description', 'Account suspension history'
        ));
    END IF;
    
    -- 10. Admin Warnings (-5 to -15 each based on severity)
    SELECT COALESCE(SUM(points_deducted), 0) INTO v_warning_points
    FROM user_warnings
    WHERE user_id = p_user_id
      AND is_active = true
      AND (expires_at IS NULL OR expires_at > NOW());
    
    IF v_warning_points > 0 THEN
        v_score := v_score - v_warning_points;
        v_breakdown := v_breakdown || jsonb_build_object('admin_warnings', jsonb_build_object(
            'points', -v_warning_points,
            'description', 'Active warnings from administrators'
        ));
    END IF;
    
    -- ========================================
    -- FINAL SCORE
    -- ========================================
    
    -- Ensure score is between 0 and 100
    v_score := GREATEST(0, LEAST(100, v_score));
    
    -- Add summary to breakdown
    v_breakdown := v_breakdown || jsonb_build_object('summary', jsonb_build_object(
        'total_score', v_score,
        'max_possible', 50,  -- 15 + 10 + 10 + 5 + 5 + 5 = 50
        'calculated_at', NOW(),
        'algorithm_version', '2.0'
    ));
    
    RETURN QUERY SELECT v_score, v_breakdown;
END;
$$;


--
-- Name: cleanup_typing_indicators(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_typing_indicators() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    DELETE FROM typing_indicators 
    WHERE started_at < CURRENT_TIMESTAMP - INTERVAL '10 seconds';
END;
$$;


--
-- Name: get_user_preferred_categories(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_preferred_categories(p_user_id integer) RETURNS TABLE(category_id integer, priority_score numeric)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    -- First, get explicit preferences (highest priority)
    SELECT ucp.category_id, (100 + ucp.priority)::DECIMAL as priority_score
    FROM user_category_preferences ucp
    WHERE ucp.user_id = p_user_id
    
    UNION ALL
    
    -- Then, get learned affinities (lower priority)
    SELECT uca.category_id, uca.affinity_score as priority_score
    FROM user_category_affinity uca
    WHERE uca.user_id = p_user_id
    AND NOT EXISTS (
        SELECT 1 FROM user_category_preferences ucp 
        WHERE ucp.user_id = p_user_id AND ucp.category_id = uca.category_id
    )
    
    ORDER BY priority_score DESC;
END;
$$;


--
-- Name: trigger_trust_score_on_kyc(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_trust_score_on_kyc() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.kyc_status IS DISTINCT FROM NEW.kyc_status THEN
        PERFORM update_user_trust_score(NEW.id, 'kyc_status_change');
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: trigger_trust_score_on_listing(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_trust_score_on_listing() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.moderation_status IS DISTINCT FROM NEW.moderation_status THEN
        PERFORM update_user_trust_score(NEW.user_id, 'listing_moderation_change');
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: trigger_trust_score_on_review(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_trust_score_on_review() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM update_user_trust_score(OLD.reviewed_user_id, 'review_deleted');
        PERFORM update_user_review_stats(OLD.reviewed_user_id);
        RETURN OLD;
    ELSE
        PERFORM update_user_trust_score(NEW.reviewed_user_id, 'review_' || LOWER(TG_OP));
        PERFORM update_user_review_stats(NEW.reviewed_user_id);
        RETURN NEW;
    END IF;
END;
$$;


--
-- Name: trigger_trust_score_on_warning(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_trust_score_on_warning() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM update_user_trust_score(NEW.user_id, 'warning_added');
    RETURN NEW;
END;
$$;


--
-- Name: trigger_update_affinity_on_search(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_update_affinity_on_search() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.category_id IS NOT NULL THEN
        PERFORM update_user_category_affinity(NEW.user_id, NEW.category_id, 'search');
    END IF;
    
    RETURN NEW;
END;
$$;


--
-- Name: trigger_update_affinity_on_view(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_update_affinity_on_view() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_category_id INTEGER;
BEGIN
    -- Get the category of the viewed listing
    SELECT categoryid INTO v_category_id
    FROM userlistings
    WHERE id = NEW.listing_id;
    
    IF v_category_id IS NOT NULL THEN
        PERFORM update_user_category_affinity(NEW.user_id, v_category_id, 'view');
    END IF;
    
    RETURN NEW;
END;
$$;


--
-- Name: update_conversation_last_message(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_conversation_last_message() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE conversations 
    SET 
        last_message_id = NEW.id,
        last_message_at = NEW.created_at,
        last_message_preview = LEFT(
            CASE 
                WHEN NEW.message_type = 'image' THEN 'ðŸ“· Photo'
                WHEN NEW.message_type = 'system' THEN NEW.content
                ELSE NEW.content
            END, 
            100
        ),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.conversation_id;
    RETURN NEW;
END;
$$;


--
-- Name: update_review_eligibility(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_review_eligibility() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Update the can_leave_reviews flag based on KYC status
    NEW.can_leave_reviews := (NEW.kyc_status = 'approved');
    RETURN NEW;
END;
$$;


--
-- Name: update_user_category_affinity(integer, integer, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_user_category_affinity(p_user_id integer, p_category_id integer, p_action_type character varying) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_weight DECIMAL(5,2);
    v_current_affinity DECIMAL(5,2);
BEGIN
    -- Assign weights based on action type
    CASE p_action_type
        WHEN 'view' THEN v_weight := 1.0;
        WHEN 'search' THEN v_weight := 2.0;
        WHEN 'contact' THEN v_weight := 5.0;
        WHEN 'favorite' THEN v_weight := 3.0;
        ELSE v_weight := 0.5;
    END CASE;
    
    -- Insert or update affinity
    INSERT INTO user_category_affinity (user_id, category_id, affinity_score, view_count, search_count, interaction_count, updated_at)
    VALUES (p_user_id, p_category_id, v_weight, 
            CASE WHEN p_action_type = 'view' THEN 1 ELSE 0 END,
            CASE WHEN p_action_type = 'search' THEN 1 ELSE 0 END,
            CASE WHEN p_action_type IN ('contact', 'favorite') THEN 1 ELSE 0 END,
            NOW())
    ON CONFLICT (user_id, category_id) DO UPDATE SET
        affinity_score = LEAST(100, user_category_affinity.affinity_score + v_weight),
        view_count = user_category_affinity.view_count + CASE WHEN p_action_type = 'view' THEN 1 ELSE 0 END,
        search_count = user_category_affinity.search_count + CASE WHEN p_action_type = 'search' THEN 1 ELSE 0 END,
        interaction_count = user_category_affinity.interaction_count + CASE WHEN p_action_type IN ('contact', 'favorite') THEN 1 ELSE 0 END,
        updated_at = NOW();
END;
$$;


--
-- Name: update_user_review_stats(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_user_review_stats(p_user_id integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE users
    SET 
        total_reviews = (
            SELECT COUNT(*) FROM user_reviews 
            WHERE reviewed_user_id = p_user_id AND is_valid = true
        ),
        average_rating = (
            SELECT COALESCE(ROUND(AVG(rating)::numeric, 2), 0) FROM user_reviews 
            WHERE reviewed_user_id = p_user_id AND is_valid = true
        )
    WHERE id = p_user_id;
END;
$$;


--
-- Name: update_user_trust_score(integer, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_user_trust_score(p_user_id integer, p_reason character varying DEFAULT 'manual_update'::character varying) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_old_score INTEGER;
    v_new_score INTEGER;
    v_breakdown JSONB;
BEGIN
    -- Get current score
    SELECT trust_score INTO v_old_score FROM users WHERE id = p_user_id;
    
    -- Calculate new score
    SELECT total_score, breakdown INTO v_new_score, v_breakdown
    FROM calculate_trust_score(p_user_id);
    
    -- Update user's trust score
    UPDATE users 
    SET 
        trust_score = v_new_score,
        trust_score_updated_at = NOW()
    WHERE id = p_user_id;
    
    -- Log the change
    INSERT INTO trust_score_history (
        user_id, old_score, new_score, change_amount, 
        change_reason, change_details, triggered_by
    ) VALUES (
        p_user_id, v_old_score, v_new_score, v_new_score - COALESCE(v_old_score, 0),
        p_reason, v_breakdown, 'system'
    );
    
    RETURN v_new_score;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_suspensions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_suspensions (
    id integer NOT NULL,
    user_id integer,
    suspension_type character varying(20) NOT NULL,
    reason text NOT NULL,
    related_report_id integer,
    suspended_by integer,
    starts_at timestamp without time zone DEFAULT now(),
    ends_at timestamp without time zone,
    is_active boolean DEFAULT true,
    lifted_by integer,
    lifted_at timestamp without time zone,
    lift_reason text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: TABLE account_suspensions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.account_suspensions IS 'Records of account suspensions with duration and reason';


--
-- Name: account_suspensions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.account_suspensions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_suspensions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.account_suspensions_id_seq OWNED BY public.account_suspensions.id;


--
-- Name: admin_broadcasts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_broadcasts (
    id integer NOT NULL,
    admin_id integer,
    title character varying(100) NOT NULL,
    message text NOT NULL,
    type character varying(50) DEFAULT 'announcement'::character varying,
    priority character varying(20) DEFAULT 'normal'::character varying,
    recipients_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: admin_broadcasts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_broadcasts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_broadcasts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_broadcasts_id_seq OWNED BY public.admin_broadcasts.id;


--
-- Name: analytics_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_events (
    id integer NOT NULL,
    listing_id integer,
    user_id integer,
    event_type character varying(50) NOT NULL,
    source character varying(50),
    referrer text,
    device_type character varying(20),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: analytics_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.analytics_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: analytics_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.analytics_events_id_seq OWNED BY public.analytics_events.id;


--
-- Name: appeals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.appeals (
    id integer NOT NULL,
    user_id integer,
    suspension_id integer,
    warning_id integer,
    appeal_type character varying(20) NOT NULL,
    related_listing_id integer,
    reason text NOT NULL,
    evidence_urls text[],
    status character varying(20) DEFAULT 'pending'::character varying,
    admin_notes text,
    reviewed_by integer,
    reviewed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: TABLE appeals; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.appeals IS 'User appeals against suspensions, warnings, or listing removals';


--
-- Name: appeals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.appeals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: appeals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.appeals_id_seq OWNED BY public.appeals.id;


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id integer NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    parentid integer,
    description text,
    icon text,
    imageurl text,
    sortoder integer DEFAULT 0,
    createdat timestamp with time zone DEFAULT now()
);


--
-- Name: categories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.categories_id_seq OWNED BY public.categories.id;


--
-- Name: chat_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_preferences (
    id integer NOT NULL,
    user_id integer NOT NULL,
    email_notifications boolean DEFAULT true,
    push_notifications boolean DEFAULT true,
    sound_enabled boolean DEFAULT true,
    read_receipts_enabled boolean DEFAULT true,
    online_status_visible boolean DEFAULT true,
    auto_reply_enabled boolean DEFAULT false,
    auto_reply_message text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: chat_preferences_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.chat_preferences_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chat_preferences_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.chat_preferences_id_seq OWNED BY public.chat_preferences.id;


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id integer NOT NULL,
    listing_id integer,
    buyer_id integer NOT NULL,
    seller_id integer NOT NULL,
    last_message_id integer,
    last_message_at timestamp without time zone,
    last_message_preview character varying(100),
    is_archived_buyer boolean DEFAULT false,
    is_archived_seller boolean DEFAULT false,
    is_blocked_by_buyer boolean DEFAULT false,
    is_blocked_by_seller boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: conversations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.conversations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: conversations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.conversations_id_seq OWNED BY public.conversations.id;


--
-- Name: imagelistings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.imagelistings (
    id integer NOT NULL,
    listingid integer NOT NULL,
    imageurl text NOT NULL,
    is_main boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: imagelistings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.imagelistings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: imagelistings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.imagelistings_id_seq OWNED BY public.imagelistings.id;


--
-- Name: kyc_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kyc_verifications (
    id integer NOT NULL,
    userid integer,
    documenttype character varying(50) NOT NULL,
    documentfronturl text NOT NULL,
    documentbackurl text,
    selfieurl text NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying,
    rejectionreason text,
    reviewedby integer,
    reviewedat timestamp without time zone,
    createdat timestamp without time zone DEFAULT now(),
    updatedat timestamp without time zone DEFAULT now()
);


--
-- Name: kyc_verifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.kyc_verifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: kyc_verifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.kyc_verifications_id_seq OWNED BY public.kyc_verifications.id;


--
-- Name: listing_analytics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_analytics (
    id integer NOT NULL,
    listing_id integer,
    views integer DEFAULT 0,
    clicks integer DEFAULT 0,
    impressions integer DEFAULT 0,
    last_viewed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: listing_analytics_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.listing_analytics_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: listing_analytics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.listing_analytics_id_seq OWNED BY public.listing_analytics.id;


--
-- Name: listing_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_reviews (
    id integer NOT NULL,
    listing_id integer,
    admin_id integer,
    action character varying(20) NOT NULL,
    reason text,
    notes text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: TABLE listing_reviews; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.listing_reviews IS 'Audit trail of all listing moderation actions';


--
-- Name: listing_reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.listing_reviews_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: listing_reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.listing_reviews_id_seq OWNED BY public.listing_reviews.id;


--
-- Name: message_read_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_read_status (
    id integer NOT NULL,
    message_id integer NOT NULL,
    user_id integer NOT NULL,
    read_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: message_read_status_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.message_read_status_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: message_read_status_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.message_read_status_id_seq OWNED BY public.message_read_status.id;


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id integer NOT NULL,
    conversation_id integer NOT NULL,
    sender_id integer NOT NULL,
    message_type character varying(20) DEFAULT 'text'::character varying,
    content text,
    image_url text,
    image_thumbnail_url text,
    status character varying(20) DEFAULT 'sent'::character varying,
    is_edited boolean DEFAULT false,
    is_deleted boolean DEFAULT false,
    reply_to_id integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    delivered_at timestamp without time zone,
    read_at timestamp without time zone
);


--
-- Name: messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.messages_id_seq OWNED BY public.messages.id;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id integer NOT NULL,
    userid integer,
    title character varying(255) NOT NULL,
    message text NOT NULL,
    type character varying(50) NOT NULL,
    isread boolean DEFAULT false,
    relatedid integer,
    relatedtype character varying(50),
    createdat timestamp without time zone DEFAULT now()
);


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    username text NOT NULL,
    phone text NOT NULL,
    passwordhash text NOT NULL,
    role text DEFAULT 'user'::text,
    country text NOT NULL,
    profilepictureurl text,
    verified boolean DEFAULT false,
    createdat timestamp with time zone,
    updatedat timestamp with time zone DEFAULT now(),
    is_suspended boolean DEFAULT false,
    suspension_reason text,
    warning_count integer DEFAULT 0,
    report_count integer DEFAULT 0,
    trust_score integer DEFAULT 0,
    trust_score_updated_at timestamp with time zone,
    bio text,
    can_leave_reviews boolean DEFAULT false,
    total_reviews integer DEFAULT 0,
    average_rating numeric(3,2) DEFAULT 0.00
);


--
-- Name: pending_appeals_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pending_appeals_view AS
 SELECT a.id,
    a.user_id,
    a.suspension_id,
    a.warning_id,
    a.appeal_type,
    a.related_listing_id,
    a.reason,
    a.evidence_urls,
    a.status,
    a.admin_notes,
    a.reviewed_by,
    a.reviewed_at,
    a.created_at,
    a.updated_at,
    u.name AS user_name,
    u.email AS user_email,
    s.reason AS suspension_reason,
    s.suspension_type
   FROM ((public.appeals a
     LEFT JOIN public.users u ON ((a.user_id = u.id)))
     LEFT JOIN public.account_suspensions s ON ((a.suspension_id = s.id)))
  WHERE ((a.status)::text = 'pending'::text)
  ORDER BY a.created_at;


--
-- Name: userlistings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.userlistings (
    id integer NOT NULL,
    userid integer NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    price numeric(12,2) NOT NULL,
    currency text DEFAULT 'USD'::text,
    categoryid integer NOT NULL,
    location text,
    country text,
    city text,
    condition text,
    phone text,
    tags text[],
    status text DEFAULT 'pending'::text,
    createdat timestamp with time zone DEFAULT now(),
    updatedat timestamp with time zone DEFAULT now(),
    moderation_status character varying(20) DEFAULT 'pending'::character varying,
    rejection_reason text,
    reviewed_by integer,
    reviewed_at timestamp without time zone
);


--
-- Name: COLUMN userlistings.moderation_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.userlistings.moderation_status IS 'Listing moderation status: pending, approved, rejected';


--
-- Name: COLUMN userlistings.rejection_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.userlistings.rejection_reason IS 'Reason provided by admin when rejecting a listing';


--
-- Name: COLUMN userlistings.reviewed_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.userlistings.reviewed_by IS 'Admin user ID who reviewed the listing';


--
-- Name: COLUMN userlistings.reviewed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.userlistings.reviewed_at IS 'Timestamp when the listing was reviewed';


--
-- Name: pending_listings_count; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pending_listings_count AS
 SELECT count(*) AS count
   FROM public.userlistings
  WHERE ((userlistings.moderation_status)::text = 'pending'::text);


--
-- Name: report_reasons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_reasons (
    id integer NOT NULL,
    category character varying(50) NOT NULL,
    reason character varying(100) NOT NULL,
    description text,
    severity integer DEFAULT 1,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: TABLE report_reasons; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.report_reasons IS 'Predefined reasons for reporting with severity levels';


--
-- Name: report_reasons_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.report_reasons_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: report_reasons_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.report_reasons_id_seq OWNED BY public.report_reasons.id;


--
-- Name: reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reports (
    id integer NOT NULL,
    reporter_id integer,
    report_type character varying(20) NOT NULL,
    reported_listing_id integer,
    reported_user_id integer,
    reason_id integer,
    custom_reason text,
    evidence_urls text[],
    status character varying(20) DEFAULT 'pending'::character varying,
    priority integer DEFAULT 1,
    admin_notes text,
    reviewed_by integer,
    reviewed_at timestamp without time zone,
    action_taken character varying(50),
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT valid_report CHECK (((((report_type)::text = 'listing'::text) AND (reported_listing_id IS NOT NULL)) OR (((report_type)::text = 'user'::text) AND (reported_user_id IS NOT NULL))))
);


--
-- Name: TABLE reports; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.reports IS 'Stores all reports submitted by users against listings or other users';


--
-- Name: report_statistics; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.report_statistics AS
 SELECT count(*) FILTER (WHERE ((reports.status)::text = 'pending'::text)) AS pending_reports,
    count(*) FILTER (WHERE ((reports.status)::text = 'reviewing'::text)) AS reviewing_reports,
    count(*) FILTER (WHERE ((reports.status)::text = 'resolved'::text)) AS resolved_reports,
    count(*) FILTER (WHERE ((reports.report_type)::text = 'listing'::text)) AS listing_reports,
    count(*) FILTER (WHERE ((reports.report_type)::text = 'user'::text)) AS user_reports,
    count(*) FILTER (WHERE (reports.priority >= 3)) AS high_priority_reports
   FROM public.reports;


--
-- Name: reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.reports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.reports_id_seq OWNED BY public.reports.id;


--
-- Name: review_fraud_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_fraud_log (
    id integer NOT NULL,
    review_id integer,
    reviewer_id integer NOT NULL,
    reviewed_user_id integer NOT NULL,
    fraud_type character varying(50) NOT NULL,
    fraud_details jsonb NOT NULL,
    severity character varying(20) NOT NULL,
    action_taken character varying(50),
    actioned_by integer,
    actioned_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT review_fraud_log_severity_check CHECK (((severity)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'critical'::character varying])::text[])))
);


--
-- Name: review_fraud_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.review_fraud_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: review_fraud_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.review_fraud_log_id_seq OWNED BY public.review_fraud_log.id;


--
-- Name: saved_searches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_searches (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    filters jsonb NOT NULL,
    notify_new_listings boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: saved_searches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.saved_searches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: saved_searches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.saved_searches_id_seq OWNED BY public.saved_searches.id;


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transactions (
    id integer NOT NULL,
    listing_id integer,
    buyer_id integer NOT NULL,
    seller_id integer NOT NULL,
    amount numeric(15,2) NOT NULL,
    currency character varying(10) DEFAULT 'XAF'::character varying,
    status character varying(30) DEFAULT 'pending'::character varying NOT NULL,
    buyer_confirmed boolean DEFAULT false,
    seller_confirmed boolean DEFAULT false,
    completed_at timestamp with time zone,
    buyer_review_left boolean DEFAULT false,
    seller_review_left boolean DEFAULT false,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT transactions_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'confirmed'::character varying, 'completed'::character varying, 'cancelled'::character varying, 'disputed'::character varying])::text[])))
);


--
-- Name: transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.transactions_id_seq OWNED BY public.transactions.id;


--
-- Name: trust_score_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trust_score_history (
    id integer NOT NULL,
    user_id integer NOT NULL,
    old_score integer,
    new_score integer NOT NULL,
    change_amount integer,
    change_reason character varying(100) NOT NULL,
    change_details jsonb DEFAULT '{}'::jsonb,
    triggered_by character varying(50),
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: trust_score_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trust_score_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trust_score_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trust_score_history_id_seq OWNED BY public.trust_score_history.id;


--
-- Name: typing_indicators; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.typing_indicators (
    id integer NOT NULL,
    conversation_id integer NOT NULL,
    user_id integer NOT NULL,
    started_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: typing_indicators_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.typing_indicators_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: typing_indicators_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.typing_indicators_id_seq OWNED BY public.typing_indicators.id;


--
-- Name: user_analytics_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_analytics_daily (
    id integer NOT NULL,
    user_id integer,
    date date NOT NULL,
    total_views integer DEFAULT 0,
    total_clicks integer DEFAULT 0,
    total_impressions integer DEFAULT 0,
    unique_visitors integer DEFAULT 0,
    revenue numeric(12,2) DEFAULT 0,
    source_search integer DEFAULT 0,
    source_browse integer DEFAULT 0,
    source_direct integer DEFAULT 0,
    source_external integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_analytics_daily_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_analytics_daily_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_analytics_daily_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_analytics_daily_id_seq OWNED BY public.user_analytics_daily.id;


--
-- Name: user_category_affinity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_category_affinity (
    id integer NOT NULL,
    user_id integer NOT NULL,
    category_id integer NOT NULL,
    affinity_score numeric(5,2) DEFAULT 0,
    view_count integer DEFAULT 0,
    search_count integer DEFAULT 0,
    interaction_count integer DEFAULT 0,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_category_affinity_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_category_affinity_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_category_affinity_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_category_affinity_id_seq OWNED BY public.user_category_affinity.id;


--
-- Name: user_category_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_category_preferences (
    id integer NOT NULL,
    user_id integer NOT NULL,
    category_id integer NOT NULL,
    priority integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_category_preferences_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_category_preferences_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_category_preferences_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_category_preferences_id_seq OWNED BY public.user_category_preferences.id;


--
-- Name: user_favorites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_favorites (
    id integer NOT NULL,
    user_id integer NOT NULL,
    favorite_user_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_favorites_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_favorites_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_favorites_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_favorites_id_seq OWNED BY public.user_favorites.id;


--
-- Name: user_listing_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_listing_views (
    id integer NOT NULL,
    user_id integer NOT NULL,
    listing_id integer NOT NULL,
    view_count integer DEFAULT 1,
    last_viewed_at timestamp without time zone DEFAULT now(),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_listing_views_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_listing_views_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_listing_views_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_listing_views_id_seq OWNED BY public.user_listing_views.id;


--
-- Name: user_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_preferences (
    id integer NOT NULL,
    user_id integer NOT NULL,
    onboarding_complete boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_preferences_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_preferences_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_preferences_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_preferences_id_seq OWNED BY public.user_preferences.id;


--
-- Name: user_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_reviews (
    id integer NOT NULL,
    reviewer_id integer NOT NULL,
    reviewed_user_id integer NOT NULL,
    listing_id integer,
    transaction_id integer,
    rating integer NOT NULL,
    title character varying(100),
    review_text text,
    review_type character varying(20) DEFAULT 'buyer_to_seller'::character varying NOT NULL,
    is_verified boolean DEFAULT false,
    is_valid boolean DEFAULT true,
    verification_method character varying(50),
    reviewer_ip character varying(45),
    reviewer_device_fingerprint character varying(255),
    fraud_flags jsonb DEFAULT '[]'::jsonb,
    fraud_score integer DEFAULT 0,
    seller_response text,
    seller_response_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT no_self_review CHECK ((reviewer_id <> reviewed_user_id)),
    CONSTRAINT user_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5))),
    CONSTRAINT user_reviews_review_type_check CHECK (((review_type)::text = ANY ((ARRAY['buyer_to_seller'::character varying, 'seller_to_buyer'::character varying])::text[])))
);


--
-- Name: user_reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_reviews_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_reviews_id_seq OWNED BY public.user_reviews.id;


--
-- Name: user_search_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_search_history (
    id integer NOT NULL,
    user_id integer NOT NULL,
    search_term character varying(255) NOT NULL,
    category_id integer,
    search_count integer DEFAULT 1,
    last_searched_at timestamp without time zone DEFAULT now(),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_search_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_search_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_search_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_search_history_id_seq OWNED BY public.user_search_history.id;


--
-- Name: user_unread_counts; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.user_unread_counts AS
 SELECT c.id AS conversation_id,
    c.buyer_id,
    c.seller_id,
    count(m.id) FILTER (WHERE ((m.sender_id <> c.buyer_id) AND ((m.status)::text <> 'read'::text) AND (NOT m.is_deleted))) AS unread_for_buyer,
    count(m.id) FILTER (WHERE ((m.sender_id <> c.seller_id) AND ((m.status)::text <> 'read'::text) AND (NOT m.is_deleted))) AS unread_for_seller
   FROM (public.conversations c
     LEFT JOIN public.messages m ON ((m.conversation_id = c.id)))
  GROUP BY c.id, c.buyer_id, c.seller_id;


--
-- Name: user_warnings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_warnings (
    id integer NOT NULL,
    user_id integer NOT NULL,
    admin_id integer,
    warning_type character varying(50) NOT NULL,
    reason text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb,
    points_deducted integer DEFAULT 5 NOT NULL,
    is_active boolean DEFAULT true,
    expires_at timestamp with time zone,
    acknowledged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT user_warnings_warning_type_check CHECK (((warning_type)::text = ANY ((ARRAY['minor'::character varying, 'moderate'::character varying, 'severe'::character varying, 'final'::character varying])::text[])))
);


--
-- Name: user_warnings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_warnings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_warnings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_warnings_id_seq OWNED BY public.user_warnings.id;


--
-- Name: userlistings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.userlistings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: userlistings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.userlistings_id_seq OWNED BY public.userlistings.id;


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: violation_warnings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.violation_warnings (
    id integer NOT NULL,
    user_id integer,
    warning_type character varying(50) NOT NULL,
    reason text NOT NULL,
    related_report_id integer,
    related_listing_id integer,
    issued_by integer,
    acknowledged boolean DEFAULT false,
    acknowledged_at timestamp without time zone,
    expires_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: TABLE violation_warnings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.violation_warnings IS 'Tracks warnings issued to users for policy violations';


--
-- Name: violation_warnings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.violation_warnings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: violation_warnings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.violation_warnings_id_seq OWNED BY public.violation_warnings.id;


--
-- Name: wishlist_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wishlist_items (
    id integer NOT NULL,
    user_id integer NOT NULL,
    listing_id integer NOT NULL,
    notify_price_drop boolean DEFAULT true,
    last_seen_price numeric,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: wishlist_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wishlist_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wishlist_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wishlist_items_id_seq OWNED BY public.wishlist_items.id;


--
-- Name: account_suspensions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_suspensions ALTER COLUMN id SET DEFAULT nextval('public.account_suspensions_id_seq'::regclass);


--
-- Name: admin_broadcasts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_broadcasts ALTER COLUMN id SET DEFAULT nextval('public.admin_broadcasts_id_seq'::regclass);


--
-- Name: analytics_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_events ALTER COLUMN id SET DEFAULT nextval('public.analytics_events_id_seq'::regclass);


--
-- Name: appeals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appeals ALTER COLUMN id SET DEFAULT nextval('public.appeals_id_seq'::regclass);


--
-- Name: categories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories ALTER COLUMN id SET DEFAULT nextval('public.categories_id_seq'::regclass);


--
-- Name: chat_preferences id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_preferences ALTER COLUMN id SET DEFAULT nextval('public.chat_preferences_id_seq'::regclass);


--
-- Name: conversations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations ALTER COLUMN id SET DEFAULT nextval('public.conversations_id_seq'::regclass);


--
-- Name: imagelistings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imagelistings ALTER COLUMN id SET DEFAULT nextval('public.imagelistings_id_seq'::regclass);


--
-- Name: kyc_verifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kyc_verifications ALTER COLUMN id SET DEFAULT nextval('public.kyc_verifications_id_seq'::regclass);


--
-- Name: listing_analytics id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_analytics ALTER COLUMN id SET DEFAULT nextval('public.listing_analytics_id_seq'::regclass);


--
-- Name: listing_reviews id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_reviews ALTER COLUMN id SET DEFAULT nextval('public.listing_reviews_id_seq'::regclass);


--
-- Name: message_read_status id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_read_status ALTER COLUMN id SET DEFAULT nextval('public.message_read_status_id_seq'::regclass);


--
-- Name: messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ALTER COLUMN id SET DEFAULT nextval('public.messages_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);


--
-- Name: report_reasons id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_reasons ALTER COLUMN id SET DEFAULT nextval('public.report_reasons_id_seq'::regclass);


--
-- Name: reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports ALTER COLUMN id SET DEFAULT nextval('public.reports_id_seq'::regclass);


--
-- Name: review_fraud_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_fraud_log ALTER COLUMN id SET DEFAULT nextval('public.review_fraud_log_id_seq'::regclass);


--
-- Name: saved_searches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_searches ALTER COLUMN id SET DEFAULT nextval('public.saved_searches_id_seq'::regclass);


--
-- Name: transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions ALTER COLUMN id SET DEFAULT nextval('public.transactions_id_seq'::regclass);


--
-- Name: trust_score_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_score_history ALTER COLUMN id SET DEFAULT nextval('public.trust_score_history_id_seq'::regclass);


--
-- Name: typing_indicators id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.typing_indicators ALTER COLUMN id SET DEFAULT nextval('public.typing_indicators_id_seq'::regclass);


--
-- Name: user_analytics_daily id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_analytics_daily ALTER COLUMN id SET DEFAULT nextval('public.user_analytics_daily_id_seq'::regclass);


--
-- Name: user_category_affinity id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_category_affinity ALTER COLUMN id SET DEFAULT nextval('public.user_category_affinity_id_seq'::regclass);


--
-- Name: user_category_preferences id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_category_preferences ALTER COLUMN id SET DEFAULT nextval('public.user_category_preferences_id_seq'::regclass);


--
-- Name: user_favorites id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_favorites ALTER COLUMN id SET DEFAULT nextval('public.user_favorites_id_seq'::regclass);


--
-- Name: user_listing_views id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_listing_views ALTER COLUMN id SET DEFAULT nextval('public.user_listing_views_id_seq'::regclass);


--
-- Name: user_preferences id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences ALTER COLUMN id SET DEFAULT nextval('public.user_preferences_id_seq'::regclass);


--
-- Name: user_reviews id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reviews ALTER COLUMN id SET DEFAULT nextval('public.user_reviews_id_seq'::regclass);


--
-- Name: user_search_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_search_history ALTER COLUMN id SET DEFAULT nextval('public.user_search_history_id_seq'::regclass);


--
-- Name: user_warnings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_warnings ALTER COLUMN id SET DEFAULT nextval('public.user_warnings_id_seq'::regclass);


--
-- Name: userlistings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.userlistings ALTER COLUMN id SET DEFAULT nextval('public.userlistings_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: violation_warnings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.violation_warnings ALTER COLUMN id SET DEFAULT nextval('public.violation_warnings_id_seq'::regclass);


--
-- Name: wishlist_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlist_items ALTER COLUMN id SET DEFAULT nextval('public.wishlist_items_id_seq'::regclass);


--
-- Name: account_suspensions account_suspensions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_suspensions
    ADD CONSTRAINT account_suspensions_pkey PRIMARY KEY (id);


--
-- Name: admin_broadcasts admin_broadcasts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_broadcasts
    ADD CONSTRAINT admin_broadcasts_pkey PRIMARY KEY (id);


--
-- Name: analytics_events analytics_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_events
    ADD CONSTRAINT analytics_events_pkey PRIMARY KEY (id);


--
-- Name: appeals appeals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appeals
    ADD CONSTRAINT appeals_pkey PRIMARY KEY (id);


--
-- Name: categories categories_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_name_key UNIQUE (name);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: categories categories_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_slug_key UNIQUE (slug);


--
-- Name: chat_preferences chat_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_preferences
    ADD CONSTRAINT chat_preferences_pkey PRIMARY KEY (id);


--
-- Name: chat_preferences chat_preferences_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_preferences
    ADD CONSTRAINT chat_preferences_user_id_key UNIQUE (user_id);


--
-- Name: conversations conversations_listing_id_buyer_id_seller_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_listing_id_buyer_id_seller_id_key UNIQUE (listing_id, buyer_id, seller_id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: imagelistings imagelistings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imagelistings
    ADD CONSTRAINT imagelistings_pkey PRIMARY KEY (id);


--
-- Name: kyc_verifications kyc_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kyc_verifications
    ADD CONSTRAINT kyc_verifications_pkey PRIMARY KEY (id);


--
-- Name: listing_analytics listing_analytics_listing_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_analytics
    ADD CONSTRAINT listing_analytics_listing_id_key UNIQUE (listing_id);


--
-- Name: listing_analytics listing_analytics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_analytics
    ADD CONSTRAINT listing_analytics_pkey PRIMARY KEY (id);


--
-- Name: listing_reviews listing_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_reviews
    ADD CONSTRAINT listing_reviews_pkey PRIMARY KEY (id);


--
-- Name: message_read_status message_read_status_message_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_read_status
    ADD CONSTRAINT message_read_status_message_id_user_id_key UNIQUE (message_id, user_id);


--
-- Name: message_read_status message_read_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_read_status
    ADD CONSTRAINT message_read_status_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: report_reasons report_reasons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_reasons
    ADD CONSTRAINT report_reasons_pkey PRIMARY KEY (id);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);


--
-- Name: review_fraud_log review_fraud_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_fraud_log
    ADD CONSTRAINT review_fraud_log_pkey PRIMARY KEY (id);


--
-- Name: saved_searches saved_searches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_searches
    ADD CONSTRAINT saved_searches_pkey PRIMARY KEY (id);


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);


--
-- Name: trust_score_history trust_score_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_score_history
    ADD CONSTRAINT trust_score_history_pkey PRIMARY KEY (id);


--
-- Name: typing_indicators typing_indicators_conversation_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.typing_indicators
    ADD CONSTRAINT typing_indicators_conversation_id_user_id_key UNIQUE (conversation_id, user_id);


--
-- Name: typing_indicators typing_indicators_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.typing_indicators
    ADD CONSTRAINT typing_indicators_pkey PRIMARY KEY (id);


--
-- Name: user_reviews unique_listing_review; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reviews
    ADD CONSTRAINT unique_listing_review UNIQUE (reviewer_id, reviewed_user_id, listing_id);


--
-- Name: user_reviews unique_transaction_review; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reviews
    ADD CONSTRAINT unique_transaction_review UNIQUE (reviewer_id, reviewed_user_id, transaction_id);


--
-- Name: user_analytics_daily user_analytics_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_analytics_daily
    ADD CONSTRAINT user_analytics_daily_pkey PRIMARY KEY (id);


--
-- Name: user_analytics_daily user_analytics_daily_user_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_analytics_daily
    ADD CONSTRAINT user_analytics_daily_user_id_date_key UNIQUE (user_id, date);


--
-- Name: user_category_affinity user_category_affinity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_category_affinity
    ADD CONSTRAINT user_category_affinity_pkey PRIMARY KEY (id);


--
-- Name: user_category_affinity user_category_affinity_user_id_category_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_category_affinity
    ADD CONSTRAINT user_category_affinity_user_id_category_id_key UNIQUE (user_id, category_id);


--
-- Name: user_category_preferences user_category_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_category_preferences
    ADD CONSTRAINT user_category_preferences_pkey PRIMARY KEY (id);


--
-- Name: user_category_preferences user_category_preferences_user_id_category_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_category_preferences
    ADD CONSTRAINT user_category_preferences_user_id_category_id_key UNIQUE (user_id, category_id);


--
-- Name: user_favorites user_favorites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_favorites
    ADD CONSTRAINT user_favorites_pkey PRIMARY KEY (id);


--
-- Name: user_favorites user_favorites_user_id_favorite_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_favorites
    ADD CONSTRAINT user_favorites_user_id_favorite_user_id_key UNIQUE (user_id, favorite_user_id);


--
-- Name: user_listing_views user_listing_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_listing_views
    ADD CONSTRAINT user_listing_views_pkey PRIMARY KEY (id);


--
-- Name: user_listing_views user_listing_views_user_id_listing_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_listing_views
    ADD CONSTRAINT user_listing_views_user_id_listing_id_key UNIQUE (user_id, listing_id);


--
-- Name: user_preferences user_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (id);


--
-- Name: user_preferences user_preferences_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_user_id_key UNIQUE (user_id);


--
-- Name: user_reviews user_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reviews
    ADD CONSTRAINT user_reviews_pkey PRIMARY KEY (id);


--
-- Name: user_search_history user_search_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_search_history
    ADD CONSTRAINT user_search_history_pkey PRIMARY KEY (id);


--
-- Name: user_search_history user_search_history_user_id_search_term_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_search_history
    ADD CONSTRAINT user_search_history_user_id_search_term_key UNIQUE (user_id, search_term);


--
-- Name: user_warnings user_warnings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_warnings
    ADD CONSTRAINT user_warnings_pkey PRIMARY KEY (id);


--
-- Name: userlistings userlistings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.userlistings
    ADD CONSTRAINT userlistings_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: violation_warnings violation_warnings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.violation_warnings
    ADD CONSTRAINT violation_warnings_pkey PRIMARY KEY (id);


--
-- Name: wishlist_items wishlist_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlist_items
    ADD CONSTRAINT wishlist_items_pkey PRIMARY KEY (id);


--
-- Name: wishlist_items wishlist_items_user_id_listing_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlist_items
    ADD CONSTRAINT wishlist_items_user_id_listing_id_key UNIQUE (user_id, listing_id);


--
-- Name: idx_admin_broadcasts_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_broadcasts_created_at ON public.admin_broadcasts USING btree (created_at DESC);


--
-- Name: idx_analytics_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_analytics_events_created ON public.analytics_events USING btree (created_at);


--
-- Name: idx_analytics_events_listing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_analytics_events_listing ON public.analytics_events USING btree (listing_id);


--
-- Name: idx_analytics_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_analytics_events_type ON public.analytics_events USING btree (event_type);


--
-- Name: idx_analytics_events_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_analytics_events_user ON public.analytics_events USING btree (user_id);


--
-- Name: idx_appeals_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appeals_status ON public.appeals USING btree (status);


--
-- Name: idx_appeals_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appeals_user ON public.appeals USING btree (user_id);


--
-- Name: idx_conversations_buyer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_buyer ON public.conversations USING btree (buyer_id);


--
-- Name: idx_conversations_buyer_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_buyer_active ON public.conversations USING btree (buyer_id) WHERE (is_archived_buyer = false);


--
-- Name: idx_conversations_last_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_last_message ON public.conversations USING btree (last_message_at DESC);


--
-- Name: idx_conversations_listing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_listing ON public.conversations USING btree (listing_id);


--
-- Name: idx_conversations_seller; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_seller ON public.conversations USING btree (seller_id);


--
-- Name: idx_conversations_seller_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_seller_active ON public.conversations USING btree (seller_id) WHERE (is_archived_seller = false);


--
-- Name: idx_fraud_log_reviewer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fraud_log_reviewer ON public.review_fraud_log USING btree (reviewer_id);


--
-- Name: idx_fraud_log_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fraud_log_severity ON public.review_fraud_log USING btree (severity);


--
-- Name: idx_kyc_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kyc_status ON public.kyc_verifications USING btree (status);


--
-- Name: idx_kyc_userid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kyc_userid ON public.kyc_verifications USING btree (userid);


--
-- Name: idx_listing_analytics_listing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_listing_analytics_listing ON public.listing_analytics USING btree (listing_id);


--
-- Name: idx_listing_reviews_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_listing_reviews_admin_id ON public.listing_reviews USING btree (admin_id);


--
-- Name: idx_listing_reviews_listing_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_listing_reviews_listing_id ON public.listing_reviews USING btree (listing_id);


--
-- Name: idx_messages_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_conversation ON public.messages USING btree (conversation_id);


--
-- Name: idx_messages_conversation_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_conversation_created ON public.messages USING btree (conversation_id, created_at DESC);


--
-- Name: idx_messages_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_created ON public.messages USING btree (created_at DESC);


--
-- Name: idx_messages_sender; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_sender ON public.messages USING btree (sender_id);


--
-- Name: idx_messages_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_unread ON public.messages USING btree (conversation_id, status) WHERE ((status)::text <> 'read'::text);


--
-- Name: idx_notifications_isread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_isread ON public.notifications USING btree (isread);


--
-- Name: idx_notifications_userid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_userid ON public.notifications USING btree (userid);


--
-- Name: idx_read_status_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_read_status_message ON public.message_read_status USING btree (message_id);


--
-- Name: idx_read_status_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_read_status_user ON public.message_read_status USING btree (user_id);


--
-- Name: idx_reports_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_created ON public.reports USING btree (created_at DESC);


--
-- Name: idx_reports_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_priority ON public.reports USING btree (priority DESC);


--
-- Name: idx_reports_reported_listing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_reported_listing ON public.reports USING btree (reported_listing_id);


--
-- Name: idx_reports_reported_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_reported_user ON public.reports USING btree (reported_user_id);


--
-- Name: idx_reports_reporter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_reporter ON public.reports USING btree (reporter_id);


--
-- Name: idx_reports_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_status ON public.reports USING btree (status);


--
-- Name: idx_reports_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_type ON public.reports USING btree (report_type);


--
-- Name: idx_reviews_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_created ON public.user_reviews USING btree (created_at DESC);


--
-- Name: idx_reviews_fraud_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_fraud_score ON public.user_reviews USING btree (fraud_score);


--
-- Name: idx_reviews_listing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_listing ON public.user_reviews USING btree (listing_id);


--
-- Name: idx_reviews_rating; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_rating ON public.user_reviews USING btree (rating);


--
-- Name: idx_reviews_reviewed_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_reviewed_user ON public.user_reviews USING btree (reviewed_user_id);


--
-- Name: idx_reviews_reviewer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_reviewer ON public.user_reviews USING btree (reviewer_id);


--
-- Name: idx_reviews_valid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_valid ON public.user_reviews USING btree (is_valid, is_verified);


--
-- Name: idx_suspensions_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suspensions_active ON public.account_suspensions USING btree (is_active);


--
-- Name: idx_suspensions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suspensions_user ON public.account_suspensions USING btree (user_id);


--
-- Name: idx_transactions_buyer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_buyer ON public.transactions USING btree (buyer_id);


--
-- Name: idx_transactions_listing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_listing ON public.transactions USING btree (listing_id);


--
-- Name: idx_transactions_seller; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_seller ON public.transactions USING btree (seller_id);


--
-- Name: idx_transactions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_status ON public.transactions USING btree (status);


--
-- Name: idx_trust_history_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trust_history_created ON public.trust_score_history USING btree (created_at DESC);


--
-- Name: idx_trust_history_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trust_history_user ON public.trust_score_history USING btree (user_id);


--
-- Name: idx_user_analytics_daily_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_analytics_daily_date ON public.user_analytics_daily USING btree (date);


--
-- Name: idx_user_analytics_daily_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_analytics_daily_user ON public.user_analytics_daily USING btree (user_id);


--
-- Name: idx_user_category_affinity_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_category_affinity_score ON public.user_category_affinity USING btree (affinity_score DESC);


--
-- Name: idx_user_category_affinity_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_category_affinity_user ON public.user_category_affinity USING btree (user_id);


--
-- Name: idx_user_category_prefs_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_category_prefs_category ON public.user_category_preferences USING btree (category_id);


--
-- Name: idx_user_category_prefs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_category_prefs_user ON public.user_category_preferences USING btree (user_id);


--
-- Name: idx_user_favorites_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_favorites_created_at ON public.user_favorites USING btree (created_at DESC);


--
-- Name: idx_user_favorites_favorite_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_favorites_favorite_user_id ON public.user_favorites USING btree (favorite_user_id);


--
-- Name: idx_user_favorites_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_favorites_user_id ON public.user_favorites USING btree (user_id);


--
-- Name: idx_user_listing_views_listing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_listing_views_listing ON public.user_listing_views USING btree (listing_id);


--
-- Name: idx_user_listing_views_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_listing_views_user ON public.user_listing_views USING btree (user_id);


--
-- Name: idx_user_preferences_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_preferences_user ON public.user_preferences USING btree (user_id);


--
-- Name: idx_user_search_history_term; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_search_history_term ON public.user_search_history USING btree (search_term);


--
-- Name: idx_user_search_history_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_search_history_user ON public.user_search_history USING btree (user_id);


--
-- Name: idx_userlistings_moderation_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_userlistings_moderation_status ON public.userlistings USING btree (moderation_status);


--
-- Name: idx_userlistings_reviewed_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_userlistings_reviewed_by ON public.userlistings USING btree (reviewed_by);


--
-- Name: idx_users_suspended; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_suspended ON public.users USING btree (is_suspended);


--
-- Name: idx_warnings_acknowledged; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warnings_acknowledged ON public.violation_warnings USING btree (acknowledged);


--
-- Name: idx_warnings_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warnings_active ON public.user_warnings USING btree (is_active);


--
-- Name: idx_warnings_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warnings_user ON public.violation_warnings USING btree (user_id);


--
-- Name: user_search_history trg_update_affinity_on_search; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_affinity_on_search AFTER INSERT OR UPDATE ON public.user_search_history FOR EACH ROW EXECUTE FUNCTION public.trigger_update_affinity_on_search();


--
-- Name: user_listing_views trg_update_affinity_on_view; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_affinity_on_view AFTER INSERT OR UPDATE ON public.user_listing_views FOR EACH ROW EXECUTE FUNCTION public.trigger_update_affinity_on_view();


--
-- Name: messages trigger_update_last_message; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_update_last_message AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.update_conversation_last_message();


--
-- Name: account_suspensions account_suspensions_lifted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_suspensions
    ADD CONSTRAINT account_suspensions_lifted_by_fkey FOREIGN KEY (lifted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: account_suspensions account_suspensions_related_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_suspensions
    ADD CONSTRAINT account_suspensions_related_report_id_fkey FOREIGN KEY (related_report_id) REFERENCES public.reports(id) ON DELETE SET NULL;


--
-- Name: account_suspensions account_suspensions_suspended_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_suspensions
    ADD CONSTRAINT account_suspensions_suspended_by_fkey FOREIGN KEY (suspended_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: account_suspensions account_suspensions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_suspensions
    ADD CONSTRAINT account_suspensions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: admin_broadcasts admin_broadcasts_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_broadcasts
    ADD CONSTRAINT admin_broadcasts_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: analytics_events analytics_events_listing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_events
    ADD CONSTRAINT analytics_events_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.userlistings(id) ON DELETE CASCADE;


--
-- Name: analytics_events analytics_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_events
    ADD CONSTRAINT analytics_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: appeals appeals_related_listing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appeals
    ADD CONSTRAINT appeals_related_listing_id_fkey FOREIGN KEY (related_listing_id) REFERENCES public.userlistings(id) ON DELETE SET NULL;


--
-- Name: appeals appeals_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appeals
    ADD CONSTRAINT appeals_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: appeals appeals_suspension_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appeals
    ADD CONSTRAINT appeals_suspension_id_fkey FOREIGN KEY (suspension_id) REFERENCES public.account_suspensions(id) ON DELETE CASCADE;


--
-- Name: appeals appeals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appeals
    ADD CONSTRAINT appeals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: appeals appeals_warning_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appeals
    ADD CONSTRAINT appeals_warning_id_fkey FOREIGN KEY (warning_id) REFERENCES public.violation_warnings(id) ON DELETE SET NULL;


--
-- Name: categories categories_parentid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_parentid_fkey FOREIGN KEY (parentid) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: chat_preferences chat_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_preferences
    ADD CONSTRAINT chat_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_listing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.userlistings(id) ON DELETE SET NULL;


--
-- Name: conversations conversations_seller_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: conversations fk_last_message; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT fk_last_message FOREIGN KEY (last_message_id) REFERENCES public.messages(id) ON DELETE SET NULL;


--
-- Name: imagelistings imagelistings_listingid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imagelistings
    ADD CONSTRAINT imagelistings_listingid_fkey FOREIGN KEY (listingid) REFERENCES public.userlistings(id) ON DELETE CASCADE;


--
-- Name: kyc_verifications kyc_verifications_reviewedby_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kyc_verifications
    ADD CONSTRAINT kyc_verifications_reviewedby_fkey FOREIGN KEY (reviewedby) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: kyc_verifications kyc_verifications_userid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kyc_verifications
    ADD CONSTRAINT kyc_verifications_userid_fkey FOREIGN KEY (userid) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: listing_analytics listing_analytics_listing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_analytics
    ADD CONSTRAINT listing_analytics_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.userlistings(id) ON DELETE CASCADE;


--
-- Name: listing_reviews listing_reviews_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_reviews
    ADD CONSTRAINT listing_reviews_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: listing_reviews listing_reviews_listing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_reviews
    ADD CONSTRAINT listing_reviews_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.userlistings(id) ON DELETE CASCADE;


--
-- Name: message_read_status message_read_status_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_read_status
    ADD CONSTRAINT message_read_status_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: message_read_status message_read_status_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_read_status
    ADD CONSTRAINT message_read_status_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: messages messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: messages messages_reply_to_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_reply_to_id_fkey FOREIGN KEY (reply_to_id) REFERENCES public.messages(id) ON DELETE SET NULL;


--
-- Name: messages messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_userid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_userid_fkey FOREIGN KEY (userid) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: reports reports_reason_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_reason_id_fkey FOREIGN KEY (reason_id) REFERENCES public.report_reasons(id) ON DELETE SET NULL;


--
-- Name: reports reports_reported_listing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_reported_listing_id_fkey FOREIGN KEY (reported_listing_id) REFERENCES public.userlistings(id) ON DELETE CASCADE;


--
-- Name: reports reports_reported_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_reported_user_id_fkey FOREIGN KEY (reported_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: reports reports_reporter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: reports reports_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: review_fraud_log review_fraud_log_review_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_fraud_log
    ADD CONSTRAINT review_fraud_log_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.user_reviews(id) ON DELETE CASCADE;


--
-- Name: review_fraud_log review_fraud_log_reviewed_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_fraud_log
    ADD CONSTRAINT review_fraud_log_reviewed_user_id_fkey FOREIGN KEY (reviewed_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: review_fraud_log review_fraud_log_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_fraud_log
    ADD CONSTRAINT review_fraud_log_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: transactions transactions_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: transactions transactions_listing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.userlistings(id) ON DELETE CASCADE;


--
-- Name: transactions transactions_seller_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: trust_score_history trust_score_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_score_history
    ADD CONSTRAINT trust_score_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: typing_indicators typing_indicators_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.typing_indicators
    ADD CONSTRAINT typing_indicators_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: typing_indicators typing_indicators_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.typing_indicators
    ADD CONSTRAINT typing_indicators_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_analytics_daily user_analytics_daily_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_analytics_daily
    ADD CONSTRAINT user_analytics_daily_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_category_affinity user_category_affinity_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_category_affinity
    ADD CONSTRAINT user_category_affinity_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE CASCADE;


--
-- Name: user_category_affinity user_category_affinity_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_category_affinity
    ADD CONSTRAINT user_category_affinity_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_category_preferences user_category_preferences_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_category_preferences
    ADD CONSTRAINT user_category_preferences_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE CASCADE;


--
-- Name: user_category_preferences user_category_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_category_preferences
    ADD CONSTRAINT user_category_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_favorites user_favorites_favorite_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_favorites
    ADD CONSTRAINT user_favorites_favorite_user_id_fkey FOREIGN KEY (favorite_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_favorites user_favorites_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_favorites
    ADD CONSTRAINT user_favorites_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_listing_views user_listing_views_listing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_listing_views
    ADD CONSTRAINT user_listing_views_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.userlistings(id) ON DELETE CASCADE;


--
-- Name: user_listing_views user_listing_views_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_listing_views
    ADD CONSTRAINT user_listing_views_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_preferences user_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_reviews user_reviews_listing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reviews
    ADD CONSTRAINT user_reviews_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.userlistings(id) ON DELETE SET NULL;


--
-- Name: user_reviews user_reviews_reviewed_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reviews
    ADD CONSTRAINT user_reviews_reviewed_user_id_fkey FOREIGN KEY (reviewed_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_reviews user_reviews_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reviews
    ADD CONSTRAINT user_reviews_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_reviews user_reviews_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reviews
    ADD CONSTRAINT user_reviews_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;


--
-- Name: user_search_history user_search_history_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_search_history
    ADD CONSTRAINT user_search_history_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: user_search_history user_search_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_search_history
    ADD CONSTRAINT user_search_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_warnings user_warnings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_warnings
    ADD CONSTRAINT user_warnings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: userlistings userlistings_categoryid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.userlistings
    ADD CONSTRAINT userlistings_categoryid_fkey FOREIGN KEY (categoryid) REFERENCES public.categories(id);


--
-- Name: userlistings userlistings_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.userlistings
    ADD CONSTRAINT userlistings_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: userlistings userlistings_userid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.userlistings
    ADD CONSTRAINT userlistings_userid_fkey FOREIGN KEY (userid) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: violation_warnings violation_warnings_issued_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.violation_warnings
    ADD CONSTRAINT violation_warnings_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: violation_warnings violation_warnings_related_listing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.violation_warnings
    ADD CONSTRAINT violation_warnings_related_listing_id_fkey FOREIGN KEY (related_listing_id) REFERENCES public.userlistings(id) ON DELETE SET NULL;


--
-- Name: violation_warnings violation_warnings_related_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.violation_warnings
    ADD CONSTRAINT violation_warnings_related_report_id_fkey FOREIGN KEY (related_report_id) REFERENCES public.reports(id) ON DELETE SET NULL;


--
-- Name: violation_warnings violation_warnings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.violation_warnings
    ADD CONSTRAINT violation_warnings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


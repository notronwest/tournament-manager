export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      audit_log: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          data: Json | null
          entity_id: string | null
          entity_type: string
          id: number
          organization_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          data?: Json | null
          entity_id?: string | null
          entity_type: string
          id?: number
          organization_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          data?: Json | null
          entity_id?: string | null
          entity_type?: string
          id?: number
          organization_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_form_submissions: {
        Row: {
          created_at: string
          id: string
          ip_hash: string | null
          message: string
          sender_email: string
          sender_name: string
          tournament_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          ip_hash?: string | null
          message: string
          sender_email: string
          sender_name: string
          tournament_id: string
        }
        Update: {
          created_at?: string
          id?: string
          ip_hash?: string | null
          message?: string
          sender_email?: string
          sender_name?: string
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_form_submissions_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      contracts: {
        Row: {
          created_at: string
          created_by: string | null
          document_html: string | null
          generated_at: string
          id: string
          quote_id: string
          revision_id: string
          status: Database["public"]["Enums"]["contract_status"]
          terms_version: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          document_html?: string | null
          generated_at?: string
          id?: string
          quote_id: string
          revision_id: string
          status?: Database["public"]["Enums"]["contract_status"]
          terms_version: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          document_html?: string | null
          generated_at?: string
          id?: string
          quote_id?: string
          revision_id?: string
          status?: Database["public"]["Enums"]["contract_status"]
          terms_version?: string
        }
        Relationships: [
          {
            foreignKeyName: "contracts_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_revision_id_fkey"
            columns: ["revision_id"]
            isOneToOne: false
            referencedRelation: "quote_revisions"
            referencedColumns: ["id"]
          },
        ]
      }
      coupons: {
        Row: {
          active: boolean
          code: string
          created_at: string
          deleted_at: string | null
          discount_type: Database["public"]["Enums"]["coupon_discount_type"]
          discount_value: number
          expires_at: string | null
          id: string
          max_uses: number | null
          starts_at: string | null
          tournament_id: string
          updated_at: string
          uses_count: number
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          deleted_at?: string | null
          discount_type: Database["public"]["Enums"]["coupon_discount_type"]
          discount_value: number
          expires_at?: string | null
          id?: string
          max_uses?: number | null
          starts_at?: string | null
          tournament_id: string
          updated_at?: string
          uses_count?: number
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          deleted_at?: string | null
          discount_type?: Database["public"]["Enums"]["coupon_discount_type"]
          discount_value?: number
          expires_at?: string | null
          id?: string
          max_uses?: number | null
          starts_at?: string | null
          tournament_id?: string
          updated_at?: string
          uses_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "coupons_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      custom_domains: {
        Row: {
          created_at: string
          host: string
          tournament_id: string
        }
        Insert: {
          created_at?: string
          host: string
          tournament_id: string
        }
        Update: {
          created_at?: string
          host?: string
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "custom_domains_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      donations: {
        Row: {
          amount_cents: number
          created_at: string
          donor_email: string
          donor_name: string
          failure_message: string | null
          id: string
          message: string | null
          organization_id: string
          payment_id: string | null
          raw: Json | null
          status: Database["public"]["Enums"]["payment_status"]
          stripe_charge_id: string | null
          stripe_connected_account_id: string | null
          stripe_payment_intent_id: string | null
          tournament_id: string
          updated_at: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          donor_email: string
          donor_name: string
          failure_message?: string | null
          id?: string
          message?: string | null
          organization_id: string
          payment_id?: string | null
          raw?: Json | null
          status?: Database["public"]["Enums"]["payment_status"]
          stripe_charge_id?: string | null
          stripe_connected_account_id?: string | null
          stripe_payment_intent_id?: string | null
          tournament_id: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          donor_email?: string
          donor_name?: string
          failure_message?: string | null
          id?: string
          message?: string | null
          organization_id?: string
          payment_id?: string | null
          raw?: Json | null
          status?: Database["public"]["Enums"]["payment_status"]
          stripe_charge_id?: string | null
          stripe_connected_account_id?: string | null
          stripe_payment_intent_id?: string | null
          tournament_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "donations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "donations_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "donations_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      e2e_test_results: {
        Row: {
          duration_ms: number | null
          expected: string | null
          file: string
          id: number
          recorded_at: string
          retries: number
          run_id: string
          sha: string | null
          status: string
          test_id: string
          title: string
        }
        Insert: {
          duration_ms?: number | null
          expected?: string | null
          file: string
          id?: never
          recorded_at?: string
          retries?: number
          run_id: string
          sha?: string | null
          status: string
          test_id: string
          title: string
        }
        Update: {
          duration_ms?: number | null
          expected?: string | null
          file?: string
          id?: never
          recorded_at?: string
          retries?: number
          run_id?: string
          sha?: string | null
          status?: string
          test_id?: string
          title?: string
        }
        Relationships: []
      }
      event_courts: {
        Row: {
          court_number: number
          created_at: string
          event_id: string
        }
        Insert: {
          court_number: number
          created_at?: string
          event_id: string
        }
        Update: {
          court_number?: number
          created_at?: string
          event_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_courts_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_registrations: {
        Row: {
          created_at: string
          deleted_at: string | null
          entitled_refund_cents: number | null
          event_fee_cents: number
          event_id: string
          id: string
          partner_registration_id: string | null
          partner_status: Database["public"]["Enums"]["partner_status"]
          player_id: string
          pool_index: number | null
          registered_at: string
          registration_side: string | null
          seed: number | null
          status: Database["public"]["Enums"]["registration_status"]
          updated_at: string
          waitlist_position: number | null
          withdrawal_decided_at: string | null
          withdrawal_decision:
            | Database["public"]["Enums"]["withdrawal_decision"]
            | null
          withdrawal_reason: string | null
          withdrawal_requested_at: string | null
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          entitled_refund_cents?: number | null
          event_fee_cents: number
          event_id: string
          id?: string
          partner_registration_id?: string | null
          partner_status?: Database["public"]["Enums"]["partner_status"]
          player_id: string
          pool_index?: number | null
          registered_at?: string
          registration_side?: string | null
          seed?: number | null
          status?: Database["public"]["Enums"]["registration_status"]
          updated_at?: string
          waitlist_position?: number | null
          withdrawal_decided_at?: string | null
          withdrawal_decision?:
            | Database["public"]["Enums"]["withdrawal_decision"]
            | null
          withdrawal_reason?: string | null
          withdrawal_requested_at?: string | null
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          entitled_refund_cents?: number | null
          event_fee_cents?: number
          event_id?: string
          id?: string
          partner_registration_id?: string | null
          partner_status?: Database["public"]["Enums"]["partner_status"]
          player_id?: string
          pool_index?: number | null
          registered_at?: string
          registration_side?: string | null
          seed?: number | null
          status?: Database["public"]["Enums"]["registration_status"]
          updated_at?: string
          waitlist_position?: number | null
          withdrawal_decided_at?: string | null
          withdrawal_decision?:
            | Database["public"]["Enums"]["withdrawal_decision"]
            | null
          withdrawal_reason?: string | null
          withdrawal_requested_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "event_registrations_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_registrations_partner_registration_id_fkey"
            columns: ["partner_registration_id"]
            isOneToOne: false
            referencedRelation: "event_registrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_registrations_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          bracket_type: Database["public"]["Enums"]["bracket_type"]
          created_at: string
          deleted_at: string | null
          event_fee_cents: number
          format: Database["public"]["Enums"]["event_format"]
          gender: Database["public"]["Enums"]["event_gender"]
          id: string
          is_paired_roles: boolean
          max_age: number | null
          max_rating: number | null
          max_teams: number | null
          medal_match_format: Database["public"]["Enums"]["medal_match_format"]
          medal_minutes_per_game: number
          medal_points_to_win: number
          medal_win_by: number
          min_age: number | null
          min_rating: number | null
          name: string
          play_each_team_times: number
          playoff_rounds: number
          points_to_win: number
          pool_count: number
          pool_minutes_per_game: number
          rating_source: Database["public"]["Enums"]["rating_source"] | null
          scheduled_start_at: string | null
          semifinal_match_format: Database["public"]["Enums"]["medal_match_format"]
          semifinal_minutes_per_game: number
          semifinal_points_to_win: number
          semifinal_win_by: number
          side_a_label: string
          side_b_label: string
          status: Database["public"]["Enums"]["event_status"]
          teams_advancing_to_playoff: number
          timeouts_per_game: number
          tournament_id: string
          updated_at: string
          win_by: number
        }
        Insert: {
          bracket_type?: Database["public"]["Enums"]["bracket_type"]
          created_at?: string
          deleted_at?: string | null
          event_fee_cents?: number
          format: Database["public"]["Enums"]["event_format"]
          gender: Database["public"]["Enums"]["event_gender"]
          id?: string
          is_paired_roles?: boolean
          max_age?: number | null
          max_rating?: number | null
          max_teams?: number | null
          medal_match_format?: Database["public"]["Enums"]["medal_match_format"]
          medal_minutes_per_game?: number
          medal_points_to_win?: number
          medal_win_by?: number
          min_age?: number | null
          min_rating?: number | null
          name: string
          play_each_team_times?: number
          playoff_rounds?: number
          points_to_win?: number
          pool_count?: number
          pool_minutes_per_game?: number
          rating_source?: Database["public"]["Enums"]["rating_source"] | null
          scheduled_start_at?: string | null
          semifinal_match_format?: Database["public"]["Enums"]["medal_match_format"]
          semifinal_minutes_per_game?: number
          semifinal_points_to_win?: number
          semifinal_win_by?: number
          side_a_label?: string
          side_b_label?: string
          status?: Database["public"]["Enums"]["event_status"]
          teams_advancing_to_playoff?: number
          timeouts_per_game?: number
          tournament_id: string
          updated_at?: string
          win_by?: number
        }
        Update: {
          bracket_type?: Database["public"]["Enums"]["bracket_type"]
          created_at?: string
          deleted_at?: string | null
          event_fee_cents?: number
          format?: Database["public"]["Enums"]["event_format"]
          gender?: Database["public"]["Enums"]["event_gender"]
          id?: string
          is_paired_roles?: boolean
          max_age?: number | null
          max_rating?: number | null
          max_teams?: number | null
          medal_match_format?: Database["public"]["Enums"]["medal_match_format"]
          medal_minutes_per_game?: number
          medal_points_to_win?: number
          medal_win_by?: number
          min_age?: number | null
          min_rating?: number | null
          name?: string
          play_each_team_times?: number
          playoff_rounds?: number
          points_to_win?: number
          pool_count?: number
          pool_minutes_per_game?: number
          rating_source?: Database["public"]["Enums"]["rating_source"] | null
          scheduled_start_at?: string | null
          semifinal_match_format?: Database["public"]["Enums"]["medal_match_format"]
          semifinal_minutes_per_game?: number
          semifinal_points_to_win?: number
          semifinal_win_by?: number
          side_a_label?: string
          side_b_label?: string
          status?: Database["public"]["Enums"]["event_status"]
          teams_advancing_to_playoff?: number
          timeouts_per_game?: number
          tournament_id?: string
          updated_at?: string
          win_by?: number
        }
        Relationships: [
          {
            foreignKeyName: "events_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback_submissions: {
        Row: {
          auth_user_id: string | null
          category: string
          created_at: string
          id: string
          ip_hash: string
          message: string
          page_url: string | null
        }
        Insert: {
          auth_user_id?: string | null
          category: string
          created_at?: string
          id?: string
          ip_hash: string
          message: string
          page_url?: string | null
        }
        Update: {
          auth_user_id?: string | null
          category?: string
          created_at?: string
          id?: string
          ip_hash?: string
          message?: string
          page_url?: string | null
        }
        Relationships: []
      }
      locations: {
        Row: {
          address: string | null
          address_line2: string | null
          ceiling_height_max_ft: number | null
          ceiling_height_min_ft: number | null
          city: string | null
          court_count: number | null
          created_at: string
          deleted_at: string | null
          id: string
          is_default: boolean
          name: string
          net_type: Database["public"]["Enums"]["net_type"] | null
          organization_id: string
          pickleball_type: string | null
          postal_code: string | null
          state: string | null
          surface_notes: string | null
          surface_type: Database["public"]["Enums"]["surface_type"] | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          address_line2?: string | null
          ceiling_height_max_ft?: number | null
          ceiling_height_min_ft?: number | null
          city?: string | null
          court_count?: number | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_default?: boolean
          name: string
          net_type?: Database["public"]["Enums"]["net_type"] | null
          organization_id: string
          pickleball_type?: string | null
          postal_code?: string | null
          state?: string | null
          surface_notes?: string | null
          surface_type?: Database["public"]["Enums"]["surface_type"] | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          address_line2?: string | null
          ceiling_height_max_ft?: number | null
          ceiling_height_min_ft?: number | null
          city?: string | null
          court_count?: number | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_default?: boolean
          name?: string
          net_type?: Database["public"]["Enums"]["net_type"] | null
          organization_id?: string
          pickleball_type?: string | null
          postal_code?: string | null
          state?: string | null
          surface_notes?: string | null
          surface_type?: Database["public"]["Enums"]["surface_type"] | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "locations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      matches: {
        Row: {
          court: string | null
          created_at: string
          event_id: string
          id: string
          match_format: Database["public"]["Enums"]["medal_match_format"] | null
          match_minutes_per_game: number | null
          match_points_to_win: number | null
          match_win_by: number | null
          notes: string | null
          position: number
          round: number
          scheduled_at: string | null
          stage: Database["public"]["Enums"]["match_stage"]
          status: Database["public"]["Enums"]["match_status"]
          team_a_reg_id: string | null
          team_a_score: number | null
          team_b_reg_id: string | null
          team_b_score: number | null
          updated_at: string
          winner_reg_id: string | null
        }
        Insert: {
          court?: string | null
          created_at?: string
          event_id: string
          id?: string
          match_format?:
            | Database["public"]["Enums"]["medal_match_format"]
            | null
          match_minutes_per_game?: number | null
          match_points_to_win?: number | null
          match_win_by?: number | null
          notes?: string | null
          position?: number
          round: number
          scheduled_at?: string | null
          stage: Database["public"]["Enums"]["match_stage"]
          status?: Database["public"]["Enums"]["match_status"]
          team_a_reg_id?: string | null
          team_a_score?: number | null
          team_b_reg_id?: string | null
          team_b_score?: number | null
          updated_at?: string
          winner_reg_id?: string | null
        }
        Update: {
          court?: string | null
          created_at?: string
          event_id?: string
          id?: string
          match_format?:
            | Database["public"]["Enums"]["medal_match_format"]
            | null
          match_minutes_per_game?: number | null
          match_points_to_win?: number | null
          match_win_by?: number | null
          notes?: string | null
          position?: number
          round?: number
          scheduled_at?: string | null
          stage?: Database["public"]["Enums"]["match_stage"]
          status?: Database["public"]["Enums"]["match_status"]
          team_a_reg_id?: string | null
          team_a_score?: number | null
          team_b_reg_id?: string | null
          team_b_score?: number | null
          updated_at?: string
          winner_reg_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "matches_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_team_a_reg_id_fkey"
            columns: ["team_a_reg_id"]
            isOneToOne: false
            referencedRelation: "event_registrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_team_b_reg_id_fkey"
            columns: ["team_b_reg_id"]
            isOneToOne: false
            referencedRelation: "event_registrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_winner_reg_id_fkey"
            columns: ["winner_reg_id"]
            isOneToOne: false
            referencedRelation: "event_registrations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_members: {
        Row: {
          created_at: string
          organization_id: string
          role: Database["public"]["Enums"]["org_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          organization_id: string
          role?: Database["public"]["Enums"]["org_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          organization_id?: string
          role?: Database["public"]["Enums"]["org_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          contact_email: string | null
          created_at: string
          deleted_at: string | null
          id: string
          name: string
          slug: string
          stripe_account_id: string | null
          stripe_account_status: Database["public"]["Enums"]["org_stripe_status"]
          updated_at: string
        }
        Insert: {
          contact_email?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          name: string
          slug: string
          stripe_account_id?: string | null
          stripe_account_status?: Database["public"]["Enums"]["org_stripe_status"]
          updated_at?: string
        }
        Update: {
          contact_email?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          name?: string
          slug?: string
          stripe_account_id?: string | null
          stripe_account_status?: Database["public"]["Enums"]["org_stripe_status"]
          updated_at?: string
        }
        Relationships: []
      }
      partner_invites: {
        Row: {
          created_at: string
          decline_message: string | null
          event_id: string
          expires_at: string | null
          id: string
          invitee_email: string | null
          invitee_player_id: string
          inviter_player_id: string
          responded_at: string | null
          status: Database["public"]["Enums"]["partner_invite_status"]
          token: string
        }
        Insert: {
          created_at?: string
          decline_message?: string | null
          event_id: string
          expires_at?: string | null
          id?: string
          invitee_email?: string | null
          invitee_player_id: string
          inviter_player_id: string
          responded_at?: string | null
          status?: Database["public"]["Enums"]["partner_invite_status"]
          token?: string
        }
        Update: {
          created_at?: string
          decline_message?: string | null
          event_id?: string
          expires_at?: string | null
          id?: string
          invitee_email?: string | null
          invitee_player_id?: string
          inviter_player_id?: string
          responded_at?: string | null
          status?: Database["public"]["Enums"]["partner_invite_status"]
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "partner_invites_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "partner_invites_invitee_player_id_fkey"
            columns: ["invitee_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "partner_invites_inviter_player_id_fkey"
            columns: ["inviter_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_line_items: {
        Row: {
          amount_cents: number
          description: string
          event_registration_id: string | null
          id: string
          payment_id: string
        }
        Insert: {
          amount_cents: number
          description: string
          event_registration_id?: string | null
          id?: string
          payment_id: string
        }
        Update: {
          amount_cents?: number
          description?: string
          event_registration_id?: string | null
          id?: string
          payment_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_line_items_event_registration_id_fkey"
            columns: ["event_registration_id"]
            isOneToOne: false
            referencedRelation: "event_registrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_line_items_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_cents: number
          created_at: string
          failure_message: string | null
          id: string
          organization_id: string
          platform_fee_cents: number
          player_id: string
          raw: Json | null
          registration_id: string | null
          status: Database["public"]["Enums"]["payment_status"]
          stripe_charge_id: string | null
          stripe_connected_account_id: string | null
          stripe_payment_intent_id: string | null
          updated_at: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          failure_message?: string | null
          id?: string
          organization_id: string
          platform_fee_cents?: number
          player_id: string
          raw?: Json | null
          registration_id?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
          stripe_charge_id?: string | null
          stripe_connected_account_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          failure_message?: string | null
          id?: string
          organization_id?: string
          platform_fee_cents?: number
          player_id?: string
          raw?: Json | null
          registration_id?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
          stripe_charge_id?: string | null
          stripe_connected_account_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_registration_id_fkey"
            columns: ["registration_id"]
            isOneToOne: false
            referencedRelation: "registrations"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_admins: {
        Row: {
          created_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          user_id?: string
        }
        Relationships: []
      }
      platform_settings: {
        Row: {
          id: boolean
          platform_fee_bps: number
          platform_fee_fixed_cents: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          id?: boolean
          platform_fee_bps?: number
          platform_fee_fixed_cents?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          id?: boolean
          platform_fee_bps?: number
          platform_fee_fixed_cents?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      player_ratings: {
        Row: {
          as_of: string
          category: string | null
          created_at: string
          id: string
          player_id: string
          raw: Json | null
          score: number | null
          source: Database["public"]["Enums"]["rating_source"]
        }
        Insert: {
          as_of: string
          category?: string | null
          created_at?: string
          id?: string
          player_id: string
          raw?: Json | null
          score?: number | null
          source: Database["public"]["Enums"]["rating_source"]
        }
        Update: {
          as_of?: string
          category?: string | null
          created_at?: string
          id?: string
          player_id?: string
          raw?: Json | null
          score?: number | null
          source?: Database["public"]["Enums"]["rating_source"]
        }
        Relationships: [
          {
            foreignKeyName: "player_ratings_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      players: {
        Row: {
          auth_user_id: string | null
          avatar_path: string | null
          city: string | null
          created_at: string
          deleted_at: string | null
          dob: string | null
          email: string | null
          first_name: string
          gender: Database["public"]["Enums"]["player_gender"] | null
          id: string
          last_name: string
          phone: string | null
          self_rating_doubles: number | null
          self_rating_mixed: number | null
          self_rating_singles: number | null
          state: string | null
          updated_at: string
        }
        Insert: {
          auth_user_id?: string | null
          avatar_path?: string | null
          city?: string | null
          created_at?: string
          deleted_at?: string | null
          dob?: string | null
          email?: string | null
          first_name: string
          gender?: Database["public"]["Enums"]["player_gender"] | null
          id?: string
          last_name: string
          phone?: string | null
          self_rating_doubles?: number | null
          self_rating_mixed?: number | null
          self_rating_singles?: number | null
          state?: string | null
          updated_at?: string
        }
        Update: {
          auth_user_id?: string | null
          avatar_path?: string | null
          city?: string | null
          created_at?: string
          deleted_at?: string | null
          dob?: string | null
          email?: string | null
          first_name?: string
          gender?: Database["public"]["Enums"]["player_gender"] | null
          id?: string
          last_name?: string
          phone?: string | null
          self_rating_doubles?: number | null
          self_rating_mixed?: number | null
          self_rating_singles?: number | null
          state?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      quote_customers: {
        Row: {
          created_at: string
          email: string
          id: string
          name: string
          notes: string | null
          org_name: string | null
          phone: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          name: string
          notes?: string | null
          org_name?: string | null
          phone?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          name?: string
          notes?: string | null
          org_name?: string | null
          phone?: string | null
        }
        Relationships: []
      }
      quote_line_items: {
        Row: {
          id: string
          label: string
          line_total_cents: number
          passthrough_cost_cents: number
          qty: number
          revision_id: string
          service_key: string
          unit_price_cents: number
        }
        Insert: {
          id?: string
          label: string
          line_total_cents: number
          passthrough_cost_cents?: number
          qty: number
          revision_id: string
          service_key: string
          unit_price_cents: number
        }
        Update: {
          id?: string
          label?: string
          line_total_cents?: number
          passthrough_cost_cents?: number
          qty?: number
          revision_id?: string
          service_key?: string
          unit_price_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "quote_line_items_revision_id_fkey"
            columns: ["revision_id"]
            isOneToOne: false
            referencedRelation: "quote_revisions"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_revisions: {
        Row: {
          created_at: string
          created_by: Database["public"]["Enums"]["quote_revision_creator"]
          estimated_net_cents: number
          estimated_revenue_cents: number
          id: string
          is_current: boolean
          notes: string | null
          quote_id: string
          revision_number: number
          subtotal_cents: number
        }
        Insert: {
          created_at?: string
          created_by?: Database["public"]["Enums"]["quote_revision_creator"]
          estimated_net_cents?: number
          estimated_revenue_cents?: number
          id?: string
          is_current?: boolean
          notes?: string | null
          quote_id: string
          revision_number?: number
          subtotal_cents?: number
        }
        Update: {
          created_at?: string
          created_by?: Database["public"]["Enums"]["quote_revision_creator"]
          estimated_net_cents?: number
          estimated_revenue_cents?: number
          id?: string
          is_current?: boolean
          notes?: string | null
          quote_id?: string
          revision_number?: number
          subtotal_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "quote_revisions_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_share_tokens: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          quote_id: string
          revoked: boolean
          token: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          quote_id: string
          revoked?: boolean
          token?: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          quote_id?: string
          revoked?: boolean
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "quote_share_tokens_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      quotes: {
        Row: {
          additional_event_fee_cents: number
          created_at: string
          customer_id: string | null
          distance_miles: number
          event_dates: string | null
          event_name: string | null
          first_event_fee_cents: number
          id: string
          multi_event_players: number
          num_days: number
          num_entries: number
          num_events: number
          platform: Database["public"]["Enums"]["quote_platform"]
          source: Database["public"]["Enums"]["quote_source"]
          status: Database["public"]["Enums"]["quote_status"]
        }
        Insert: {
          additional_event_fee_cents?: number
          created_at?: string
          customer_id?: string | null
          distance_miles?: number
          event_dates?: string | null
          event_name?: string | null
          first_event_fee_cents?: number
          id?: string
          multi_event_players?: number
          num_days: number
          num_entries?: number
          num_events?: number
          platform?: Database["public"]["Enums"]["quote_platform"]
          source?: Database["public"]["Enums"]["quote_source"]
          status?: Database["public"]["Enums"]["quote_status"]
        }
        Update: {
          additional_event_fee_cents?: number
          created_at?: string
          customer_id?: string | null
          distance_miles?: number
          event_dates?: string | null
          event_name?: string | null
          first_event_fee_cents?: number
          id?: string
          multi_event_players?: number
          num_days?: number
          num_entries?: number
          num_events?: number
          platform?: Database["public"]["Enums"]["quote_platform"]
          source?: Database["public"]["Enums"]["quote_source"]
          status?: Database["public"]["Enums"]["quote_status"]
        }
        Relationships: [
          {
            foreignKeyName: "quotes_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "quote_customers"
            referencedColumns: ["id"]
          },
        ]
      }
      registrations: {
        Row: {
          created_at: string
          deleted_at: string | null
          entry_fee_cents: number
          id: string
          player_id: string
          registered_at: string
          status: Database["public"]["Enums"]["registration_status"]
          tournament_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          entry_fee_cents: number
          id?: string
          player_id: string
          registered_at?: string
          status?: Database["public"]["Enums"]["registration_status"]
          tournament_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          entry_fee_cents?: number
          id?: string
          player_id?: string
          registered_at?: string
          status?: Database["public"]["Enums"]["registration_status"]
          tournament_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "registrations_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "registrations_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      service_catalog: {
        Row: {
          active: boolean
          category: Database["public"]["Enums"]["service_category"]
          created_at: string
          id: string
          key: string
          name: string
          notes: string | null
          plus_passthrough_cost: boolean
          sort_order: number
          unit: Database["public"]["Enums"]["service_unit"]
          unit_price_cents: number
        }
        Insert: {
          active?: boolean
          category: Database["public"]["Enums"]["service_category"]
          created_at?: string
          id?: string
          key: string
          name: string
          notes?: string | null
          plus_passthrough_cost?: boolean
          sort_order?: number
          unit: Database["public"]["Enums"]["service_unit"]
          unit_price_cents: number
        }
        Update: {
          active?: boolean
          category?: Database["public"]["Enums"]["service_category"]
          created_at?: string
          id?: string
          key?: string
          name?: string
          notes?: string | null
          plus_passthrough_cost?: boolean
          sort_order?: number
          unit?: Database["public"]["Enums"]["service_unit"]
          unit_price_cents?: number
        }
        Relationships: []
      }
      tournament_change_requests: {
        Row: {
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["change_request_kind"]
          organizer_resolution: string | null
          payload: Json
          player_id: string
          resolved_at: string | null
          resolved_by: string | null
          status: Database["public"]["Enums"]["change_request_status"]
          tournament_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: Database["public"]["Enums"]["change_request_kind"]
          organizer_resolution?: string | null
          payload?: Json
          player_id: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["change_request_status"]
          tournament_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["change_request_kind"]
          organizer_resolution?: string | null
          payload?: Json
          player_id?: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["change_request_status"]
          tournament_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_change_requests_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_change_requests_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_contacts: {
        Row: {
          created_at: string
          deleted_at: string | null
          email: string | null
          id: string
          is_public: boolean
          name: string
          phone: string | null
          receives_form_messages: boolean
          role: string | null
          sort_order: number
          tournament_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          id?: string
          is_public?: boolean
          name: string
          phone?: string | null
          receives_form_messages?: boolean
          role?: string | null
          sort_order?: number
          tournament_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          id?: string
          is_public?: boolean
          name?: string
          phone?: string | null
          receives_form_messages?: boolean
          role?: string | null
          sort_order?: number
          tournament_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_contacts_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_pricing_tiers: {
        Row: {
          additional_event_fee_cents: number
          created_at: string
          ends_at: string | null
          first_event_fee_cents: number
          id: string
          label: string
          sort_order: number
          starts_at: string | null
          tournament_id: string
          updated_at: string
        }
        Insert: {
          additional_event_fee_cents?: number
          created_at?: string
          ends_at?: string | null
          first_event_fee_cents?: number
          id?: string
          label: string
          sort_order: number
          starts_at?: string | null
          tournament_id: string
          updated_at?: string
        }
        Update: {
          additional_event_fee_cents?: number
          created_at?: string
          ends_at?: string | null
          first_event_fee_cents?: number
          id?: string
          label?: string
          sort_order?: number
          starts_at?: string | null
          tournament_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_pricing_tiers_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tournaments: {
        Row: {
          accepts_donations: boolean
          additional_info_md: string | null
          archived_at: string | null
          cancellation_policy_preset:
            | Database["public"]["Enums"]["cancellation_policy_preset"]
            | null
          court_count: number
          created_at: string
          deleted_at: string | null
          description: string | null
          donation_prompt: string | null
          ends_at: string
          facility_info_md: string | null
          faqs_md: string | null
          id: string
          inter_event_buffer_minutes: number
          location_address: string | null
          location_id: string | null
          location_name: string | null
          name: string
          organization_id: string
          pickleball_type: string | null
          pricing_pattern: Database["public"]["Enums"]["pricing_pattern"]
          refund_policy_md: string | null
          registration_closes_at: string | null
          registration_opens_at: string | null
          slug: string
          sponsors_md: string | null
          starts_at: string
          status: Database["public"]["Enums"]["tournament_status"]
          updated_at: string
          weather_md: string | null
        }
        Insert: {
          accepts_donations?: boolean
          additional_info_md?: string | null
          archived_at?: string | null
          cancellation_policy_preset?:
            | Database["public"]["Enums"]["cancellation_policy_preset"]
            | null
          court_count?: number
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          donation_prompt?: string | null
          ends_at: string
          facility_info_md?: string | null
          faqs_md?: string | null
          id?: string
          inter_event_buffer_minutes?: number
          location_address?: string | null
          location_id?: string | null
          location_name?: string | null
          name: string
          organization_id: string
          pickleball_type?: string | null
          pricing_pattern?: Database["public"]["Enums"]["pricing_pattern"]
          refund_policy_md?: string | null
          registration_closes_at?: string | null
          registration_opens_at?: string | null
          slug: string
          sponsors_md?: string | null
          starts_at: string
          status?: Database["public"]["Enums"]["tournament_status"]
          updated_at?: string
          weather_md?: string | null
        }
        Update: {
          accepts_donations?: boolean
          additional_info_md?: string | null
          archived_at?: string | null
          cancellation_policy_preset?:
            | Database["public"]["Enums"]["cancellation_policy_preset"]
            | null
          court_count?: number
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          donation_prompt?: string | null
          ends_at?: string
          facility_info_md?: string | null
          faqs_md?: string | null
          id?: string
          inter_event_buffer_minutes?: number
          location_address?: string | null
          location_id?: string | null
          location_name?: string | null
          name?: string
          organization_id?: string
          pickleball_type?: string | null
          pricing_pattern?: Database["public"]["Enums"]["pricing_pattern"]
          refund_policy_md?: string | null
          registration_closes_at?: string | null
          registration_opens_at?: string | null
          slug?: string
          sponsors_md?: string | null
          starts_at?: string
          status?: Database["public"]["Enums"]["tournament_status"]
          updated_at?: string
          weather_md?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tournaments_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournaments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      e2e_test_history: {
        Row: {
          failed: number | null
          file: string | null
          last_seen: string | null
          last_status: string | null
          pass_rate_pct: number | null
          passed: number | null
          runs: number | null
          skipped: number | null
          test_id: string | null
          title: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      accept_partner_invite: {
        Args: { p_invite_id: string }
        Returns: undefined
      }
      compute_checkout_total: {
        Args: { p_player_id: string; p_tournament_id: string }
        Returns: Json
      }
      current_player_id: { Args: never; Returns: string }
      current_pricing_tier: {
        Args: { as_of?: string; tournament_id_arg: string }
        Returns: {
          additional_event_fee_cents: number
          created_at: string
          ends_at: string | null
          first_event_fee_cents: number
          id: string
          label: string
          sort_order: number
          starts_at: string | null
          tournament_id: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "tournament_pricing_tiers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      decline_partner_invite: {
        Args: { p_invite_id: string; p_decline_message?: string | null }
        Returns: undefined
      }
      event_roster: {
        Args: { p_event_ids: string[] }
        Returns: {
          age: number
          city: string
          event_id: string
          first_name: string
          gender: Database["public"]["Enums"]["player_gender"]
          invited_partner_first_name: string
          invited_partner_last_name: string
          last_name: string
          partner_registration_id: string
          partner_status: Database["public"]["Enums"]["partner_status"]
          pending_invite_id: string
          pending_partner_reg_id: string
          registration_id: string
          self_rating_doubles: number
          self_rating_mixed: number
          self_rating_singles: number
          state: string
        }[]
      }
      file_refund_request: {
        Args: { p_reason?: string; p_reg_id: string }
        Returns: boolean
      }
      find_user_by_email: { Args: { p_email: string }; Returns: string }
      format_rating: { Args: { n: number }; Returns: string }
      get_invite_context: {
        Args: { p_token: string }
        Returns: {
          event_fee_cents: number
          event_format: Database["public"]["Enums"]["event_format"]
          event_id: string
          event_name: string
          invite_id: string
          invite_status: Database["public"]["Enums"]["partner_invite_status"]
          invitee_email: string
          inviter_email: string
          inviter_first_name: string
          inviter_last_name: string
          inviter_phone: string
          org_slug: string
          tournament_id: string
          tournament_name: string
          tournament_slug: string
        }[]
      }
      get_quote_by_token: {
        Args: { p_token: string }
        Returns: Database["public"]["CompositeTypes"]["quote_share_payload"]
        SetofOptions: {
          from: "*"
          to: "quote_share_payload"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      has_org_role: {
        Args: { min_role: Database["public"]["Enums"]["org_role"]; org: string }
        Returns: boolean
      }
      is_event_full: { Args: { p_event_id: string }; Returns: boolean }
      is_org_member: { Args: { org: string }; Returns: boolean }
      is_platform_admin: { Args: never; Returns: boolean }
      join_waitlist: {
        Args: { p_event_id: string }
        Returns: {
          reg_id: string
          waitlist_position: number
        }[]
      }
      players_registered_for_events: {
        Args: { p_event_ids: string[] }
        Returns: {
          event_id: string
          player_id: string
        }[]
      }
      promote_from_waitlist: {
        Args: { p_event_id: string }
        Returns: {
          promoted_player_id: string
          promoted_reg_id: string
        }[]
      }
      redeem_coupon: { Args: { p_coupon_id: string }; Returns: boolean }
      refund_compute: {
        Args: { p_event_registration_id: string }
        Returns: {
          charge_id: string
          connected_acct: string
          decision: string
          paid_cents: number
          partner_reg_id: string
          payment_id: string
          payment_intent: string
          preset: Database["public"]["Enums"]["cancellation_policy_preset"]
          refund_cents: number
          reg_status: Database["public"]["Enums"]["registration_status"]
        }[]
      }
      replace_pricing_tiers: {
        Args: { p_tiers: Json; p_tournament_id: string }
        Returns: undefined
      }
      resolve_share_token: { Args: { p_token: string }; Returns: string }
      submit_customer_revision: {
        Args: {
          p_estimated_net_cents: number
          p_estimated_revenue_cents: number
          p_line_items: Json
          p_notes?: string
          p_subtotal_cents: number
          p_token: string
        }
        Returns: string
      }
      validate_coupon: {
        Args: {
          p_code: string
          p_subtotal_cents: number
          p_tournament_id: string
        }
        Returns: Json
      }
      waitlist_effective_position: {
        Args: { p_reg_id: string }
        Returns: number
      }
      withdraw_self: {
        Args: { p_reg_id: string }
        Returns: {
          entitled_cents: number
          new_status: Database["public"]["Enums"]["registration_status"]
          promoted_player_id: string
          promoted_reg_id: string
        }[]
      }
    }
    Enums: {
      bracket_type:
        | "round_robin"
        | "single_elim"
        | "double_elim"
        | "pool_then_bracket"
      cancellation_policy_preset: "generous" | "standard" | "strict" | "custom"
      change_request_kind:
        | "division_change"
        | "partner_change"
        | "withdrawal"
        | "other"
      change_request_status: "open" | "approved" | "denied" | "cancelled"
      contract_status: "draft" | "sent" | "signed_offline"
      coupon_discount_type: "percent" | "fixed_amount"
      event_format: "singles" | "doubles"
      event_gender: "men" | "women" | "mixed" | "open"
      event_status:
        | "draft"
        | "active"
        | "complete"
        | "ready"
        | "on_hold"
        | "medal_round"
        | "verified"
      match_stage: "round_robin" | "playoff"
      match_status: "pending" | "in_progress" | "completed"
      medal_match_format: "single_game" | "best_of_3"
      net_type: "permanent" | "moveable"
      org_role: "owner" | "admin" | "staff"
      org_stripe_status: "not_connected" | "pending" | "active" | "restricted"
      partner_invite_status:
        | "pending"
        | "accepted"
        | "declined"
        | "cancelled"
        | "expired"
      partner_status: "solo" | "pending" | "confirmed" | "declined" | "seeking"
      payment_status:
        | "pending"
        | "processing"
        | "succeeded"
        | "failed"
        | "refunded"
        | "partially_refunded"
      player_gender: "M" | "F" | "X"
      pricing_pattern:
        | "single"
        | "early_bird"
        | "early_bird_plus_late"
        | "custom"
      quote_platform: "bertanderne" | "pickleballbrackets"
      quote_revision_creator: "public" | "admin" | "customer"
      quote_source: "public" | "admin"
      quote_status: "submitted" | "draft" | "quoted" | "accepted" | "declined"
      rating_source: "dupr" | "pbvision" | "wmpc_rating_hub" | "self"
      registration_status:
        | "pending_payment"
        | "paid"
        | "refunded"
        | "cancelled"
        | "withdrawn"
        | "waitlisted_pending_payment"
        | "waitlisted"
      service_category:
        | "core"
        | "setup"
        | "branding"
        | "awards"
        | "equipment"
        | "media"
      service_unit:
        | "per_day"
        | "per_event"
        | "per_player"
        | "per_entrant"
        | "flat"
        | "each"
      surface_type:
        | "concrete"
        | "asphalt"
        | "cushion_core"
        | "hardwood"
        | "polycarbonate"
        | "polyurethane"
        | "other"
      tournament_status:
        | "draft"
        | "published"
        | "closed"
        | "completed"
        | "cancelled"
      withdrawal_decision: "approved" | "denied"
    }
    CompositeTypes: {
      quote_share_payload: {
        quote_id: string | null
        event_name: string | null
        event_dates: string | null
        num_days: number | null
        num_events: number | null
        num_entries: number | null
        multi_event_players: number | null
        distance_miles: number | null
        platform: string | null
        first_event_fee_cents: number | null
        additional_event_fee_cents: number | null
        revision_id: string | null
        revision_number: number | null
        revision_notes: string | null
        subtotal_cents: number | null
        estimated_revenue_cents: number | null
        estimated_net_cents: number | null
        line_items: Json | null
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      bracket_type: [
        "round_robin",
        "single_elim",
        "double_elim",
        "pool_then_bracket",
      ],
      cancellation_policy_preset: ["generous", "standard", "strict", "custom"],
      change_request_kind: [
        "division_change",
        "partner_change",
        "withdrawal",
        "other",
      ],
      change_request_status: ["open", "approved", "denied", "cancelled"],
      contract_status: ["draft", "sent", "signed_offline"],
      coupon_discount_type: ["percent", "fixed_amount"],
      event_format: ["singles", "doubles"],
      event_gender: ["men", "women", "mixed", "open"],
      event_status: [
        "draft",
        "active",
        "complete",
        "ready",
        "on_hold",
        "medal_round",
        "verified",
      ],
      match_stage: ["round_robin", "playoff"],
      match_status: ["pending", "in_progress", "completed"],
      medal_match_format: ["single_game", "best_of_3"],
      net_type: ["permanent", "moveable"],
      org_role: ["owner", "admin", "staff"],
      org_stripe_status: ["not_connected", "pending", "active", "restricted"],
      partner_invite_status: [
        "pending",
        "accepted",
        "declined",
        "cancelled",
        "expired",
      ],
      partner_status: ["solo", "pending", "confirmed", "declined", "seeking"],
      payment_status: [
        "pending",
        "processing",
        "succeeded",
        "failed",
        "refunded",
        "partially_refunded",
      ],
      player_gender: ["M", "F", "X"],
      pricing_pattern: [
        "single",
        "early_bird",
        "early_bird_plus_late",
        "custom",
      ],
      quote_platform: ["bertanderne", "pickleballbrackets"],
      quote_revision_creator: ["public", "admin", "customer"],
      quote_source: ["public", "admin"],
      quote_status: ["submitted", "draft", "quoted", "accepted", "declined"],
      rating_source: ["dupr", "pbvision", "wmpc_rating_hub", "self"],
      registration_status: [
        "pending_payment",
        "paid",
        "refunded",
        "cancelled",
        "withdrawn",
        "waitlisted_pending_payment",
        "waitlisted",
      ],
      service_category: [
        "core",
        "setup",
        "branding",
        "awards",
        "equipment",
        "media",
      ],
      service_unit: [
        "per_day",
        "per_event",
        "per_player",
        "per_entrant",
        "flat",
        "each",
      ],
      surface_type: [
        "concrete",
        "asphalt",
        "cushion_core",
        "hardwood",
        "polycarbonate",
        "polyurethane",
        "other",
      ],
      tournament_status: [
        "draft",
        "published",
        "closed",
        "completed",
        "cancelled",
      ],
      withdrawal_decision: ["approved", "denied"],
    },
  },
} as const

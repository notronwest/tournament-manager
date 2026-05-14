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
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
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
          event_fee_cents: number
          event_id: string
          id: string
          partner_registration_id: string | null
          partner_status: Database["public"]["Enums"]["partner_status"]
          player_id: string
          pool_index: number | null
          registered_at: string
          seed: number | null
          status: Database["public"]["Enums"]["registration_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          event_fee_cents: number
          event_id: string
          id?: string
          partner_registration_id?: string | null
          partner_status?: Database["public"]["Enums"]["partner_status"]
          player_id: string
          pool_index?: number | null
          registered_at?: string
          seed?: number | null
          status?: Database["public"]["Enums"]["registration_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          event_fee_cents?: number
          event_id?: string
          id?: string
          partner_registration_id?: string | null
          partner_status?: Database["public"]["Enums"]["partner_status"]
          player_id?: string
          pool_index?: number | null
          registered_at?: string
          seed?: number | null
          status?: Database["public"]["Enums"]["registration_status"]
          updated_at?: string
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
      matches: {
        Row: {
          court: string | null
          created_at: string
          event_id: string
          id: string
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
          state: string | null
          updated_at: string
        }
        Insert: {
          auth_user_id?: string | null
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
          state?: string | null
          updated_at?: string
        }
        Update: {
          auth_user_id?: string | null
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
          state?: string | null
          updated_at?: string
        }
        Relationships: []
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
      tournaments: {
        Row: {
          court_count: number
          created_at: string
          deleted_at: string | null
          description: string | null
          ends_at: string
          entry_fee_cents: number
          id: string
          location_address: string | null
          location_name: string | null
          name: string
          organization_id: string
          registration_closes_at: string | null
          registration_opens_at: string | null
          slug: string
          starts_at: string
          status: Database["public"]["Enums"]["tournament_status"]
          updated_at: string
        }
        Insert: {
          court_count?: number
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          ends_at: string
          entry_fee_cents?: number
          id?: string
          location_address?: string | null
          location_name?: string | null
          name: string
          organization_id: string
          registration_closes_at?: string | null
          registration_opens_at?: string | null
          slug: string
          starts_at: string
          status?: Database["public"]["Enums"]["tournament_status"]
          updated_at?: string
        }
        Update: {
          court_count?: number
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          ends_at?: string
          entry_fee_cents?: number
          id?: string
          location_address?: string | null
          location_name?: string | null
          name?: string
          organization_id?: string
          registration_closes_at?: string | null
          registration_opens_at?: string | null
          slug?: string
          starts_at?: string
          status?: Database["public"]["Enums"]["tournament_status"]
          updated_at?: string
        }
        Relationships: [
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
      [_ in never]: never
    }
    Functions: {
      current_player_id: { Args: never; Returns: string }
      has_org_role: {
        Args: { min_role: Database["public"]["Enums"]["org_role"]; org: string }
        Returns: boolean
      }
      is_org_member: { Args: { org: string }; Returns: boolean }
    }
    Enums: {
      bracket_type:
        | "round_robin"
        | "single_elim"
        | "double_elim"
        | "pool_then_bracket"
      event_format: "singles" | "doubles"
      event_gender: "men" | "women" | "mixed"
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
      org_role: "owner" | "admin" | "staff"
      org_stripe_status: "not_connected" | "pending" | "active" | "restricted"
      partner_invite_status:
        | "pending"
        | "accepted"
        | "declined"
        | "cancelled"
        | "expired"
      partner_status: "solo" | "pending" | "confirmed" | "declined"
      payment_status:
        | "pending"
        | "processing"
        | "succeeded"
        | "failed"
        | "refunded"
        | "partially_refunded"
      player_gender: "M" | "F" | "X"
      rating_source: "dupr" | "pbvision" | "wmpc_rating_hub"
      registration_status:
        | "pending_payment"
        | "paid"
        | "refunded"
        | "cancelled"
        | "withdrawn"
      tournament_status:
        | "draft"
        | "published"
        | "closed"
        | "completed"
        | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      bracket_type: [
        "round_robin",
        "single_elim",
        "double_elim",
        "pool_then_bracket",
      ],
      event_format: ["singles", "doubles"],
      event_gender: ["men", "women", "mixed"],
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
      org_role: ["owner", "admin", "staff"],
      org_stripe_status: ["not_connected", "pending", "active", "restricted"],
      partner_invite_status: [
        "pending",
        "accepted",
        "declined",
        "cancelled",
        "expired",
      ],
      partner_status: ["solo", "pending", "confirmed", "declined"],
      payment_status: [
        "pending",
        "processing",
        "succeeded",
        "failed",
        "refunded",
        "partially_refunded",
      ],
      player_gender: ["M", "F", "X"],
      rating_source: ["dupr", "pbvision", "wmpc_rating_hub"],
      registration_status: [
        "pending_payment",
        "paid",
        "refunded",
        "cancelled",
        "withdrawn",
      ],
      tournament_status: [
        "draft",
        "published",
        "closed",
        "completed",
        "cancelled",
      ],
    },
  },
} as const

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
      attorneys: {
        Row: {
          bar_number: string | null
          cl_attorney_id: number | null
          created_at: string
          firm_id: string | null
          id: string
          name: string
          normalized_name: string | null
          source: string
          updated_at: string
        }
        Insert: {
          bar_number?: string | null
          cl_attorney_id?: number | null
          created_at?: string
          firm_id?: string | null
          id?: string
          name: string
          normalized_name?: string | null
          source?: string
          updated_at?: string
        }
        Update: {
          bar_number?: string | null
          cl_attorney_id?: number | null
          created_at?: string
          firm_id?: string | null
          id?: string
          name?: string
          normalized_name?: string | null
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "attorneys_firm_id_fkey"
            columns: ["firm_id"]
            isOneToOne: false
            referencedRelation: "firms"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action_type: string
          created_at: string
          id: string
          output_id: string | null
          query_text: string | null
          resource_id: string | null
          resource_type: string | null
          source_documents_used: Json | null
          user_id: string | null
        }
        Insert: {
          action_type: string
          created_at?: string
          id?: string
          output_id?: string | null
          query_text?: string | null
          resource_id?: string | null
          resource_type?: string | null
          source_documents_used?: Json | null
          user_id?: string | null
        }
        Update: {
          action_type?: string
          created_at?: string
          id?: string
          output_id?: string | null
          query_text?: string | null
          resource_id?: string | null
          resource_type?: string | null
          source_documents_used?: Json | null
          user_id?: string | null
        }
        Relationships: []
      }
      cases: {
        Row: {
          assigned_judge_id: string | null
          assigned_judge_str: string | null
          case_name: string | null
          case_name_short: string | null
          case_role: Database["public"]["Enums"]["case_role"]
          case_status: string | null
          cause: string | null
          cl_date_modified: string | null
          cl_docket_id: number
          court_id: string | null
          created_at: string
          date_filed: string | null
          date_last_filing: string | null
          date_terminated: string | null
          docket_number: string | null
          docket_number_core: string | null
          id: string
          jurisdiction_type: string | null
          jury_demand: string | null
          mdl_number: string | null
          nature_of_suit: string | null
          pacer_case_id: string | null
          parent_case_id: string | null
          referred_judge_id: string | null
          referred_judge_str: string | null
          source: string
          source_url: string | null
          updated_at: string
        }
        Insert: {
          assigned_judge_id?: string | null
          assigned_judge_str?: string | null
          case_name?: string | null
          case_name_short?: string | null
          case_role?: Database["public"]["Enums"]["case_role"]
          case_status?: string | null
          cause?: string | null
          cl_date_modified?: string | null
          cl_docket_id: number
          court_id?: string | null
          created_at?: string
          date_filed?: string | null
          date_last_filing?: string | null
          date_terminated?: string | null
          docket_number?: string | null
          docket_number_core?: string | null
          id?: string
          jurisdiction_type?: string | null
          jury_demand?: string | null
          mdl_number?: string | null
          nature_of_suit?: string | null
          pacer_case_id?: string | null
          parent_case_id?: string | null
          referred_judge_id?: string | null
          referred_judge_str?: string | null
          source?: string
          source_url?: string | null
          updated_at?: string
        }
        Update: {
          assigned_judge_id?: string | null
          assigned_judge_str?: string | null
          case_name?: string | null
          case_name_short?: string | null
          case_role?: Database["public"]["Enums"]["case_role"]
          case_status?: string | null
          cause?: string | null
          cl_date_modified?: string | null
          cl_docket_id?: number
          court_id?: string | null
          created_at?: string
          date_filed?: string | null
          date_last_filing?: string | null
          date_terminated?: string | null
          docket_number?: string | null
          docket_number_core?: string | null
          id?: string
          jurisdiction_type?: string | null
          jury_demand?: string | null
          mdl_number?: string | null
          nature_of_suit?: string | null
          pacer_case_id?: string | null
          parent_case_id?: string | null
          referred_judge_id?: string | null
          referred_judge_str?: string | null
          source?: string
          source_url?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cases_assigned_judge_id_fkey"
            columns: ["assigned_judge_id"]
            isOneToOne: false
            referencedRelation: "judges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cases_court_id_fkey"
            columns: ["court_id"]
            isOneToOne: false
            referencedRelation: "courts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cases_parent_case_id_fkey"
            columns: ["parent_case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cases_referred_judge_id_fkey"
            columns: ["referred_judge_id"]
            isOneToOne: false
            referencedRelation: "judges"
            referencedColumns: ["id"]
          },
        ]
      }
      courts: {
        Row: {
          cl_court_id: string
          court_type: string | null
          created_at: string
          federal_circuit: string | null
          id: string
          jurisdiction: string | null
          name: string | null
          short_name: string | null
          source: string
          state: string | null
          updated_at: string
          website_url: string | null
        }
        Insert: {
          cl_court_id: string
          court_type?: string | null
          created_at?: string
          federal_circuit?: string | null
          id?: string
          jurisdiction?: string | null
          name?: string | null
          short_name?: string | null
          source?: string
          state?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Update: {
          cl_court_id?: string
          court_type?: string | null
          created_at?: string
          federal_circuit?: string | null
          id?: string
          jurisdiction?: string | null
          name?: string | null
          short_name?: string | null
          source?: string
          state?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Relationships: []
      }
      docket_entries: {
        Row: {
          case_id: string
          cl_date_modified: string | null
          cl_docket_entry_id: number
          created_at: string
          date_filed: string | null
          description_clean: string | null
          description_raw: string | null
          document_type: string | null
          entry_number: number | null
          event_type: string | null
          id: string
          motion_type: string | null
          pacer_sequence_number: number | null
          recap_sequence_number: string | null
          source: string
          time_filed: string | null
          updated_at: string
        }
        Insert: {
          case_id: string
          cl_date_modified?: string | null
          cl_docket_entry_id: number
          created_at?: string
          date_filed?: string | null
          description_clean?: string | null
          description_raw?: string | null
          document_type?: string | null
          entry_number?: number | null
          event_type?: string | null
          id?: string
          motion_type?: string | null
          pacer_sequence_number?: number | null
          recap_sequence_number?: string | null
          source?: string
          time_filed?: string | null
          updated_at?: string
        }
        Update: {
          case_id?: string
          cl_date_modified?: string | null
          cl_docket_entry_id?: number
          created_at?: string
          date_filed?: string | null
          description_clean?: string | null
          description_raw?: string | null
          document_type?: string | null
          entry_number?: number | null
          event_type?: string | null
          id?: string
          motion_type?: string | null
          pacer_sequence_number?: number | null
          recap_sequence_number?: string | null
          source?: string
          time_filed?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "docket_entries_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      document_pages: {
        Row: {
          clean_text: string | null
          created_at: string
          document_id: string
          extracted_text: string | null
          extraction_confidence: number | null
          extraction_method: string | null
          id: string
          ocr_text: string | null
          page_number: number
          token_count: number | null
          updated_at: string
        }
        Insert: {
          clean_text?: string | null
          created_at?: string
          document_id: string
          extracted_text?: string | null
          extraction_confidence?: number | null
          extraction_method?: string | null
          id?: string
          ocr_text?: string | null
          page_number: number
          token_count?: number | null
          updated_at?: string
        }
        Update: {
          clean_text?: string | null
          created_at?: string
          document_id?: string
          extracted_text?: string | null
          extraction_confidence?: number | null
          extraction_method?: string | null
          id?: string
          ocr_text?: string | null
          page_number?: number
          token_count?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_pages_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          attachment_number: number | null
          availability_status: Database["public"]["Enums"]["document_availability"]
          case_id: string
          cl_date_modified: string | null
          cl_recap_document_id: number
          created_at: string
          docket_entry_id: string
          document_number: string | null
          document_type_code: number | null
          document_type_desc: string | null
          downloaded_at: string | null
          extracted_at: string | null
          file_size: number | null
          filepath_ia: string | null
          filepath_local: string | null
          filepath_recap: string | null
          id: string
          is_available_remote: boolean
          is_restricted: boolean | null
          is_sealed: boolean | null
          pacer_doc_id: string | null
          page_count: number | null
          sha1: string | null
          short_description: string | null
          source: string
          source_url: string | null
          updated_at: string
        }
        Insert: {
          attachment_number?: number | null
          availability_status?: Database["public"]["Enums"]["document_availability"]
          case_id: string
          cl_date_modified?: string | null
          cl_recap_document_id: number
          created_at?: string
          docket_entry_id: string
          document_number?: string | null
          document_type_code?: number | null
          document_type_desc?: string | null
          downloaded_at?: string | null
          extracted_at?: string | null
          file_size?: number | null
          filepath_ia?: string | null
          filepath_local?: string | null
          filepath_recap?: string | null
          id?: string
          is_available_remote?: boolean
          is_restricted?: boolean | null
          is_sealed?: boolean | null
          pacer_doc_id?: string | null
          page_count?: number | null
          sha1?: string | null
          short_description?: string | null
          source?: string
          source_url?: string | null
          updated_at?: string
        }
        Update: {
          attachment_number?: number | null
          availability_status?: Database["public"]["Enums"]["document_availability"]
          case_id?: string
          cl_date_modified?: string | null
          cl_recap_document_id?: number
          created_at?: string
          docket_entry_id?: string
          document_number?: string | null
          document_type_code?: number | null
          document_type_desc?: string | null
          downloaded_at?: string | null
          extracted_at?: string | null
          file_size?: number | null
          filepath_ia?: string | null
          filepath_local?: string | null
          filepath_recap?: string | null
          id?: string
          is_available_remote?: boolean
          is_restricted?: boolean | null
          is_sealed?: boolean | null
          pacer_doc_id?: string | null
          page_count?: number | null
          sha1?: string | null
          short_description?: string | null
          source?: string
          source_url?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_docket_entry_id_fkey"
            columns: ["docket_entry_id"]
            isOneToOne: false
            referencedRelation: "docket_entries"
            referencedColumns: ["id"]
          },
        ]
      }
      firms: {
        Row: {
          cl_firm_id: number | null
          created_at: string
          id: string
          name: string
          normalized_name: string | null
          source: string
          updated_at: string
        }
        Insert: {
          cl_firm_id?: number | null
          created_at?: string
          id?: string
          name: string
          normalized_name?: string | null
          source?: string
          updated_at?: string
        }
        Update: {
          cl_firm_id?: number | null
          created_at?: string
          id?: string
          name?: string
          normalized_name?: string | null
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      ingestion_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          error_message: string | null
          id: string
          job_type: string
          query_params: Json | null
          records_failed: number
          records_found: number
          records_ingested: number
          source: string
          started_at: string | null
          status: Database["public"]["Enums"]["ingestion_status"]
          target_ref: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          job_type: string
          query_params?: Json | null
          records_failed?: number
          records_found?: number
          records_ingested?: number
          source?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["ingestion_status"]
          target_ref?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          job_type?: string
          query_params?: Json | null
          records_failed?: number
          records_found?: number
          records_ingested?: number
          source?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["ingestion_status"]
          target_ref?: string | null
        }
        Relationships: []
      }
      judges: {
        Row: {
          cl_person_id: number | null
          created_at: string
          first_name: string | null
          full_name: string
          id: string
          initials: string | null
          last_name: string | null
          position: string | null
          source: string
          updated_at: string
        }
        Insert: {
          cl_person_id?: number | null
          created_at?: string
          first_name?: string | null
          full_name: string
          id?: string
          initials?: string | null
          last_name?: string | null
          position?: string | null
          source?: string
          updated_at?: string
        }
        Update: {
          cl_person_id?: number | null
          created_at?: string
          first_name?: string | null
          full_name?: string
          id?: string
          initials?: string | null
          last_name?: string | null
          position?: string | null
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      parties: {
        Row: {
          case_id: string
          cl_party_id: number | null
          created_at: string
          entity_type: string | null
          id: string
          name: string
          normalized_name: string | null
          party_role: string | null
          party_type: string | null
          source: string
          updated_at: string
        }
        Insert: {
          case_id: string
          cl_party_id?: number | null
          created_at?: string
          entity_type?: string | null
          id?: string
          name: string
          normalized_name?: string | null
          party_role?: string | null
          party_type?: string | null
          source?: string
          updated_at?: string
        }
        Update: {
          case_id?: string
          cl_party_id?: number | null
          created_at?: string
          entity_type?: string | null
          id?: string
          name?: string
          normalized_name?: string | null
          party_role?: string | null
          party_type?: string | null
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "parties_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      party_attorneys: {
        Row: {
          attorney_id: string
          case_id: string
          created_at: string
          id: string
          party_id: string
          role: string | null
        }
        Insert: {
          attorney_id: string
          case_id: string
          created_at?: string
          id?: string
          party_id: string
          role?: string | null
        }
        Update: {
          attorney_id?: string
          case_id?: string
          created_at?: string
          id?: string
          party_id?: string
          role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "party_attorneys_attorney_id_fkey"
            columns: ["attorney_id"]
            isOneToOne: false
            referencedRelation: "attorneys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_attorneys_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_attorneys_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "parties"
            referencedColumns: ["id"]
          },
        ]
      }
      raw_payloads: {
        Row: {
          cl_object_id: number | null
          content_hash: string | null
          created_at: string
          endpoint: string
          fetched_at: string
          id: string
          ingestion_job_id: string | null
          payload: Json
          source: string
        }
        Insert: {
          cl_object_id?: number | null
          content_hash?: string | null
          created_at?: string
          endpoint: string
          fetched_at?: string
          id?: string
          ingestion_job_id?: string | null
          payload: Json
          source?: string
        }
        Update: {
          cl_object_id?: number | null
          content_hash?: string | null
          created_at?: string
          endpoint?: string
          fetched_at?: string
          id?: string
          ingestion_job_id?: string | null
          payload?: Json
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "raw_payloads_ingestion_job_id_fkey"
            columns: ["ingestion_job_id"]
            isOneToOne: false
            referencedRelation: "ingestion_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      case_role: "mdl_master" | "member" | "related" | "standalone"
      document_availability:
        | "unavailable"
        | "available_remote"
        | "downloaded"
        | "extracted"
        | "failed"
      ingestion_status:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "partial"
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
  public: {
    Enums: {
      case_role: ["mdl_master", "member", "related", "standalone"],
      document_availability: [
        "unavailable",
        "available_remote",
        "downloaded",
        "extracted",
        "failed",
      ],
      ingestion_status: ["queued", "running", "succeeded", "failed", "partial"],
    },
  },
} as const

import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types/supabase";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY env vars.",
  );
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey);

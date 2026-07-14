import { createClient } from "@supabase/supabase-js";

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

export async function createOrder(values) {
  const { data, error } = await db.from("orders").insert(values).select("*").single();
  if (error) throw error;
  return data;
}

export async function listOrders() {
  const { data, error } = await db.from("orders").select("*").order("created_at", { ascending: false }).limit(500);
  if (error) throw error;
  return data;
}

export async function getOrder(id) {
  const { data, error } = await db.from("orders").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

export async function updateOrder(id, values) {
  const { data, error } = await db.from("orders").update(values).eq("id", id).select("*").single();
  if (error) throw error;
  return data;
}

export async function listDrivers() {
  const { data, error } = await db.from("drivers").select("*").order("name");
  if (error) throw error;
  return data;
}

export async function createDriver(values) {
  const { data, error } = await db.from("drivers").insert(values).select("*").single();
  if (error) throw error;
  return data;
}

export async function updateDriver(id, values) {
  const { data, error } = await db.from("drivers").update(values).eq("id", id).select("*").single();
  if (error) throw error;
  return data;
}


export async function getDriverByUsername(username) {
  const { data, error } = await db
    .from("drivers")
    .select("*")
    .ilike("username", username)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function getDriverById(id) {
  const { data, error } = await db
    .from("drivers")
    .select("*")
    .eq("id", id)
    .single();

  if (error) throw error;
  return data;
}

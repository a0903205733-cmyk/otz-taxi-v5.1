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
  const { data, error } = await db.from("orders").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("ORDER_NOT_FOUND");
  return data;
}

export async function updateOrder(id, values) {
  const { data, error } = await db.from("orders").update(values).eq("id", id).select("*").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("ORDER_NOT_FOUND");
  return data;
}

export async function claimOrder(orderId, driverId, finalFare = null) {
  const { data, error } = await db.rpc("claim_order_v2", {
    p_order_id: orderId,
    p_driver_id: driverId,
    p_final_fare: finalFare
  });
  if (error) throw error;

  // claim_order_v2 returns JSON directly, avoiding PostgREST single-row
  // coercion and conflicts with older claim_order function signatures.
  const claimed = Array.isArray(data) ? data[0] : data;
  if (!claimed) {
    throw new Error("CLAIM_ORDER_EMPTY_RESULT");
  }
  return claimed;
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
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("DRIVER_NOT_FOUND");
  return data;
}

export async function listVehicles() {
  const { data, error } = await db
    .from("vehicles")
    .select("*")
    .order("plate");

  if (error) throw error;
  return data;
}

export async function getVehicleById(id) {
  const { data, error } = await db
    .from("vehicles")
    .select("*")
    .eq("id", id)
    .single();

  if (error) throw error;
  return data;
}

export async function createVehicle(values) {
  const { data, error } = await db
    .from("vehicles")
    .insert(values)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

export async function updateVehicle(id, values) {
  const { data, error } = await db
    .from("vehicles")
    .update(values)
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

export function subscribeToFleetChanges(onChange) {
  return db
    .channel("otz-fleet-v5-2")
    .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, payload =>
      onChange({ table: "orders", ...payload })
    )
    .on("postgres_changes", { event: "*", schema: "public", table: "drivers" }, payload =>
      onChange({ table: "drivers", ...payload })
    )
    .on("postgres_changes", { event: "*", schema: "public", table: "vehicles" }, payload =>
      onChange({ table: "vehicles", ...payload })
    )
    .subscribe();
}

export async function listSettings() {
  const { data, error } = await db.from("settings").select("key,value").order("key");
  if (error) throw error;
  return Object.fromEntries(data.map(item => [item.key, item.value]));
}

export async function updateSetting(key, value) {
  const { data, error } = await db
    .from("settings")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" })
    .select("key,value")
    .single();
  if (error) throw error;
  return data;
}

export async function listCustomers() {
  const { data, error } = await db.from("customers").select("*").order("updated_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function updateCustomer(id, values) {
  const { data, error } = await db
    .from("customers")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function upsertCustomerByLineId(lineUserId, values = {}) {
  if (!lineUserId) return null;
  const { data, error } = await db
    .from("customers")
    .upsert(
      { line_user_id: lineUserId, ...values, updated_at: new Date().toISOString() },
      { onConflict: "line_user_id" }
    )
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function createPayment(values) {
  const { data, error } = await db.from("payments").insert(values).select("*").single();
  if (error) throw error;
  return data;
}

export async function createReceipt(values) {
  const { data, error } = await db.from("receipts").upsert(values, { onConflict: "order_id" }).select("*").single();
  if (error) throw error;
  return data;
}

export async function getReceiptByOrderId(orderId) {
  const { data, error } = await db.from("receipts").select("*").eq("order_id", orderId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function listAuditLogs() {
  const { data, error } = await db.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(500);
  if (error) throw error;
  return data;
}

export async function createAuditLog(values) {
  const { error } = await db.from("audit_logs").insert(values);
  if (error) console.error("Audit log error:", error);
}

<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OTZ 車隊管理後台 V4.2</title>
<style>
:root{--bg:#0b0b0c;--panel:#171719;--panel2:#232326;--gold:#d8b64f;--text:#f4f4f5;--muted:#aaa;--line:#333;--green:#1fc76a;--red:#e45151;--blue:#4b89ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui}
header{background:#111;color:var(--gold);padding:18px 20px;font-size:23px;font-weight:800}
main{max-width:1280px;margin:auto;padding:18px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:15px;margin-bottom:14px}
.toolbar,.form{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
input,select,button{font:inherit;border-radius:9px;border:1px solid var(--line);padding:10px 12px}
input,select{background:var(--panel2);color:var(--text)}button{background:var(--gold);color:#111;font-weight:700;cursor:pointer}
button.red{background:var(--red);color:#fff}button.green{background:var(--green)}button.blue{background:var(--blue);color:#fff}button.gray{background:#3b3b40;color:#fff}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card{background:var(--panel2);border-radius:12px;padding:14px}
.orders{display:grid;gap:12px}.order{background:var(--panel2);border-radius:12px;padding:14px}.route{font-size:18px;font-weight:700;margin:8px 0}.meta{color:var(--muted);line-height:1.7}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.driver-list{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
@media(max-width:900px){.grid,.driver-list{grid-template-columns:repeat(2,1fr)}}@media(max-width:560px){.grid,.driver-list{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>OTZ 車隊管理後台 V4.2</header>
<main>
<section class="panel toolbar">
  <input id="adminToken" type="password" placeholder="管理密碼">
  <button onclick="login()">登入／更新</button>
  <span id="msg"></span>
</section>

<section class="panel">
  <h3>新增司機帳號</h3>
  <div class="form">
    <input id="dName" placeholder="姓名">
    <input id="dUsername" placeholder="登入帳號">
    <input id="dPassword" type="password" placeholder="密碼至少8字元">
    <input id="dPhone" placeholder="電話">
    <input id="dPlate" placeholder="車牌">
    <input id="dVehicle" placeholder="車型">
    <button onclick="addDriver()">建立司機</button>
  </div>
</section>

<section class="panel">
  <h3>司機管理</h3>
  <div id="drivers" class="driver-list"></div>
</section>

<section class="panel">
  <h3>訂單</h3>
  <div id="orders" class="orders"></div>
</section>
</main>

<script>
let token=localStorage.getItem("otzAdmin")||"";
let driverData=[],orderData=[];
adminToken.value=token;

async function api(url,opt={}){
  opt.headers={...(opt.headers||{}),"x-admin-token":token};
  const r=await fetch(url,opt);
  const data=await r.json();
  if(!r.ok) throw new Error(data.error||"操作失敗");
  return data;
}

async function login(){
  token=adminToken.value.trim();
  localStorage.setItem("otzAdmin",token);
  await refresh();
}

async function refresh(){
  try{
    msg.textContent="更新中…";
    [driverData,orderData]=await Promise.all([
      api("/api/admin/drivers"),
      api("/api/admin/orders")
    ]);
    renderDrivers();
    renderOrders();
    msg.textContent="已更新";
  }catch(e){msg.textContent=e.message}
}

async function addDriver(){
  try{
    await api("/api/admin/drivers",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        name:dName.value.trim(),
        username:dUsername.value.trim(),
        password:dPassword.value,
        phone:dPhone.value.trim(),
        plate:dPlate.value.trim(),
        vehicle:dVehicle.value.trim()
      })
    });
    dName.value=dUsername.value=dPassword.value=dPhone.value=dPlate.value=dVehicle.value="";
    await refresh();
  }catch(e){alert(e.message)}
}

async function toggleDriver(id){
  try{
    await api(`/api/admin/drivers/${id}/toggle`,{method:"POST"});
    await refresh();
  }catch(e){alert(e.message)}
}

function renderDrivers(){
  drivers.innerHTML=driverData.length?driverData.map(d=>`
    <div class="card">
      <b>${esc(d.name)}</b><br>
      帳號：${esc(d.username||"未設定")}<br>
      電話：${esc(d.phone||"—")}<br>
      車牌：${esc(d.plate||"—")}<br>
      狀態：${esc(d.status)}<br>
      啟用：${d.is_active?"是":"否"}<br><br>
      <button class="${d.is_active?"red":"green"}" onclick="toggleDriver(${d.id})">
        ${d.is_active?"停用":"啟用"}
      </button>
    </div>`).join(""):"尚未建立司機";
}

function renderOrders(){
  orders.innerHTML=orderData.map(o=>`
    <div class="order">
      <b>OTZ-${String(o.id).padStart(6,"0")}</b>｜${esc(o.status)}
      <div class="route">${esc(o.pickup)} → ${esc(o.destination)}</div>
      <div class="meta">
        預約：${esc(o.ride_time||"未提供")}｜車資：${o.final_fare||o.estimated_fare||0} 元<br>
        司機：${esc(o.driver_name||"未指派")}
      </div>
      <div class="actions">
        ${o.status==="pending"?`<button class="green" onclick="assign(${o.id},${o.estimated_fare||0})">派單</button>`:""}
        ${o.status==="accepted"?`<button class="blue" onclick="orderAction(${o.id},'complete')">完成</button>`:""}
        ${!["completed","cancelled"].includes(o.status)?`<button class="red" onclick="orderAction(${o.id},'cancel')">取消</button>`:""}
      </div>
    </div>`).join("");
}

async function assign(id,estimate){
  const available=driverData.filter(d=>d.is_active);
  if(!available.length){alert("請先建立並啟用司機");return}
  const choice=prompt("輸入司機ID\\n"+available.map(d=>`${d.id}：${d.name}（${d.status}）`).join("\\n"));
  if(!choice)return;
  const finalFare=prompt("確認最終車資",estimate);
  if(finalFare===null)return;
  try{
    await api(`/api/admin/orders/${id}/assign`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({driverId:Number(choice),finalFare:Number(finalFare)})
    });
    await refresh();
  }catch(e){alert(e.message)}
}

async function orderAction(id,action){
  if(!confirm("確定執行？"))return;
  try{
    await api(`/api/admin/orders/${id}/action`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action})
    });
    await refresh();
  }catch(e){alert(e.message)}
}

function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
if(token)refresh();
</script>
</body>
</html>

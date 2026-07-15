export async function getRoute(origin, destination, apiKey) {
  const [validatedOrigin, validatedDestination] = await Promise.all([
    geocodeTaiwanAddress(origin, apiKey, "上車地點"),
    geocodeTaiwanAddress(destination, apiKey, "下車地點")
  ]);

  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration"
    },
    body: JSON.stringify({
      origin: { location: { latLng: validatedOrigin.location } },
      destination: { location: { latLng: validatedDestination.location } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      languageCode: "zh-TW",
      units: "METRIC"
    })
  });

  const raw = await response.text();
  if (!response.ok) throw new Error(`Routes API ${response.status}: ${raw}`);

  const route = JSON.parse(raw).routes?.[0];
  if (!route) throw new Error("找不到路線");

  return {
    distanceKm: route.distanceMeters / 1000,
    durationMin: Number(String(route.duration).replace("s", "")) / 60,
    originAddress: validatedOrigin.formattedAddress,
    destinationAddress: validatedDestination.formattedAddress
  };
}

async function geocodeTaiwanAddress(value, apiKey, label) {
  const originalAddress = String(value || "").trim();
  const address = normalizeTaiwanPlace(originalAddress);
  if (!address) throw new Error(`${label}不能空白`);

  const params = new URLSearchParams({
    address,
    components: "country:TW",
    region: "tw",
    language: "zh-TW",
    key: apiKey
  });
  const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
  const payload = await response.json();

  if (!response.ok || payload.status !== "OK" || !payload.results?.length) {
    const error = new Error(`${label}無法確認位於台灣，請輸入完整的台灣地址或地標`);
    error.code = "LOCATION_OUTSIDE_TAIWAN";
    throw error;
  }

  const result = payload.results[0];
  const country = result.address_components?.find(component =>
    component.types?.includes("country")
  );
  const location = result.geometry?.location;
  const addressText = [
    result.formatted_address,
    ...(result.address_components || []).map(component => component.long_name)
  ].join(" ");
  const excludedIslands = [
    "澎湖", "金門", "連江縣", "馬祖",
    "琉球鄉", "小琉球", "綠島鄉", "綠島", "蘭嶼鄉", "蘭嶼"
  ];
  const isExcludedIsland = excludedIslands.some(name => addressText.includes(name));
  const inMainIslandBounds = location &&
    Number(location.lat) >= 21.75 && Number(location.lat) <= 25.35 &&
    Number(location.lng) >= 120 && Number(location.lng) <= 122;

  validateAdministrativeHint(originalAddress, addressText, label);

  if (result.partial_match) {
    const error = new Error(`${label}只能部分符合，請輸入更完整的縣市、區域、地址或地標全名`);
    error.code = "LOCATION_AMBIGUOUS";
    throw error;
  }

  if (country?.short_name !== "TW" || !inMainIslandBounds || isExcludedIsland) {
    const error = new Error(`${label}不在台灣本島服務範圍內`);
    error.code = "LOCATION_OUTSIDE_TAIWAN";
    throw error;
  }

  return {
    formattedAddress: result.formatted_address,
    location: {
      latitude: Number(location.lat),
      longitude: Number(location.lng)
    }
  };
}

function normalizeTaiwanPlace(value) {
  const text = String(value || "").trim();
  const compact = text.replace(/[\s()（）]/g, "");
  const aliases = [
    {
      matches: ["東港鎮海宮", "東港鎮海里鎮海宮", "東港海宮"],
      address: "東港鎮海宮, 屏東縣東港鎮鎮海里鎮海路42號之5"
    },
    {
      matches: ["高雄榮總", "高雄榮民總醫院", "高榮"],
      address: "高雄榮民總醫院, 高雄市左營區大中一路386號"
    },
    {
      matches: ["高醫", "高雄醫學院", "高雄醫學大學附設醫院", "高醫附院"],
      address: "高雄醫學大學附設中和紀念醫院, 高雄市三民區自由一路100號"
    },
    {
      matches: ["左營高鐵", "高鐵左營站", "左營高鐵站"],
      address: "高鐵左營站, 高雄市左營區高鐵路105號"
    },
    {
      matches: ["小港機場", "高雄機場", "高雄國際機場"],
      address: "高雄國際機場, 高雄市小港區中山四路2號"
    }
  ];

  const alias = aliases.find(item =>
    item.matches.some(name => compact === name || compact.includes(name))
  );
  return alias?.address || text;
}

function validateAdministrativeHint(original, resolved, label) {
  const rules = [
    { token: "東港", required: ["屏東縣", "東港鎮"] },
    { token: "潮州", required: ["屏東縣", "潮州鎮"] },
    { token: "林邊", required: ["屏東縣", "林邊鄉"] },
    { token: "佳冬", required: ["屏東縣", "佳冬鄉"] },
    { token: "枋寮", required: ["屏東縣", "枋寮鄉"] },
    { token: "屏東", required: ["屏東縣"] },
    { token: "高雄", required: ["高雄市"] }
  ];
  const rule = rules.find(item => String(original).includes(item.token));
  if (rule && !rule.required.every(name => resolved.includes(name))) {
    const error = new Error(`${label}解析到錯誤縣市，請輸入完整地址或正確地標名稱`);
    error.code = "LOCATION_AMBIGUOUS";
    throw error;
  }
}

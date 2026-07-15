export async function getRoute(origin, destination, apiKey, fareSettings = {}) {
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
      computeAlternativeRoutes: true,
      languageCode: "zh-TW",
      units: "METRIC"
    })
  });

  const raw = await response.text();
  if (!response.ok) throw new Error(`Routes API ${response.status}: ${raw}`);

  const routes = JSON.parse(raw).routes || [];
  if (!routes.length) throw new Error("找不到路線");

  const perKm = Number(fareSettings.per_km ?? process.env.PER_KM ?? 20);
  const perMinute = Number(fareSettings.per_minute ?? process.env.PER_MINUTE ?? 2);
  const candidates = routes.map(route => {
    const distanceKm = route.distanceMeters / 1000;
    const durationMin = Number(String(route.duration).replace("s", "")) / 60;
    return {
      distanceKm,
      durationMin,
      score: distanceKm * perKm + durationMin * perMinute
    };
  }).filter(route => Number.isFinite(route.distanceKm) && Number.isFinite(route.durationMin));

  candidates.sort((a, b) => a.score - b.score || a.durationMin - b.durationMin);
  const route = candidates[0];
  if (!route) throw new Error("找不到有效路線");

  return {
    distanceKm: route.distanceKm,
    durationMin: route.durationMin,
    alternativesEvaluated: candidates.length,
    originAddress: validatedOrigin.formattedAddress,
    destinationAddress: validatedDestination.formattedAddress,
    originLocation: validatedOrigin.location,
    destinationLocation: validatedDestination.location
  };
}

export async function getPickupEtaMinutes(latitude, longitude, pickup, apiKey) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("DRIVER_LOCATION_REQUIRED");
  }

  // Driver GPS must also be on Taiwan's main island.
  if (lat < 21.75 || lat > 25.35 || lng < 120 || lng > 122) {
    throw new Error("DRIVER_LOCATION_OUTSIDE_TAIWAN");
  }

  const destinationLocation = pickup && typeof pickup === "object"
    ? { latitude: Number(pickup.latitude), longitude: Number(pickup.longitude) }
    : (await geocodeTaiwanAddress(pickup, apiKey, "上車地點")).location;
  if (!Number.isFinite(destinationLocation.latitude) || !Number.isFinite(destinationLocation.longitude)) {
    throw new Error("PICKUP_LOCATION_REQUIRED");
  }
  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters"
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: lat, longitude: lng } } },
      destination: { location: { latLng: destinationLocation } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      computeAlternativeRoutes: true,
      languageCode: "zh-TW",
      units: "METRIC"
    })
  });

  const raw = await response.text();
  if (!response.ok) throw new Error(`Routes API ${response.status}: ${raw}`);
  const routes = JSON.parse(raw).routes || [];
  const candidates = routes.map(route => ({
    durationMin: Number(String(route.duration || "").replace("s", "")) / 60,
    distanceKm: Number(route.distanceMeters || 0) / 1000
  })).filter(route => Number.isFinite(route.durationMin) && route.durationMin >= 0);

  candidates.sort((a, b) => a.durationMin - b.durationMin || a.distanceKm - b.distanceKm);
  if (!candidates.length) throw new Error("NO_PICKUP_ROUTE");
  return candidates[0];
}

async function geocodeTaiwanAddress(value, apiKey, label) {
  const originalAddress = String(value || "").trim();
  validateKnownLandmarkConflict(originalAddress, label);
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

  const trustedNormalizedPlace = address !== originalAddress || isAdministrativeAreaQuery(originalAddress);
  if (result.partial_match && !trustedNormalizedPlace) {
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
    { exactOnly: true, matches: ["東港", "東港鎮"], address: "屏東縣東港鎮" },
    { exactOnly: true, matches: ["林邊", "林邊鄉"], address: "屏東縣林邊鄉" },
    { exactOnly: true, matches: ["潮州", "潮州鎮"], address: "屏東縣潮州鎮" },
    { exactOnly: true, matches: ["佳冬", "佳冬鄉"], address: "屏東縣佳冬鄉" },
    { exactOnly: true, matches: ["枋寮", "枋寮鄉"], address: "屏東縣枋寮鄉" },
    { exactOnly: true, matches: ["高雄", "高雄市"], address: "高雄市" },
    { exactOnly: true, matches: ["台北", "臺北", "台北市", "臺北市"], address: "臺北市" },
    {
      matches: ["林邊分局", "林邊分駐所"],
      address: "屏東縣政府警察局東港分局林邊分駐所"
    },
    {
      matches: ["夢時代", "高雄夢時代", "統一夢時代", "統一夢時代購物中心"],
      address: "統一夢時代購物中心 高雄市前鎮區中華五路789號"
    },
    {
      matches: ["東港鎮海宮", "東港鎮海里鎮海宮", "東港海宮"],
      address: "東港鎮海宮, 屏東縣東港鎮鎮海里鎮海路42號之5"
    },
    {
      matches: ["榮總", "高雄榮總", "高雄榮民總醫院", "高榮"],
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
    item.matches.some(name => compact === name || (!item.exactOnly && compact.includes(name)))
  );
  return alias?.address || text;
}

function isAdministrativeAreaQuery(value) {
  const compact = String(value || "").replace(/[\s()（）]/g, "");
  return [
    "東港", "東港鎮", "林邊", "林邊鄉", "潮州", "潮州鎮",
    "佳冬", "佳冬鄉", "枋寮", "枋寮鄉", "高雄", "高雄市",
    "台北", "臺北", "台北市", "臺北市"
  ].includes(compact);
}

function validateKnownLandmarkConflict(original, label) {
  const compact = String(original || "").replace(/\s+/g, "");
  const conflicts = [
    {
      landmark: "夢時代",
      allowedCities: ["高雄", "前鎮"],
      conflictingCities: [
        "台北", "臺北", "新北", "桃園", "新竹", "苗栗", "台中", "臺中",
        "彰化", "南投", "雲林", "嘉義", "台南", "臺南", "屏東", "宜蘭",
        "花蓮", "台東", "臺東", "基隆"
      ],
      correctPlace: "高雄市前鎮區的統一夢時代購物中心"
    }
  ];

  for (const rule of conflicts) {
    if (!compact.includes(rule.landmark)) continue;
    const conflictingCity = rule.conflictingCities.find(city => compact.includes(city));
    if (!conflictingCity) continue;

    const error = new Error(
      `${label}「${original}」地點矛盾：${rule.landmark}位於${rule.correctPlace}，` +
      `不在${conflictingCity}。請重新輸入正確地點。`
    );
    error.code = "LOCATION_CONFLICT";
    throw error;
  }
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

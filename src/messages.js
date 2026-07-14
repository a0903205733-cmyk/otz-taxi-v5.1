export const orderNo = id => `OTZ-${String(id).padStart(6, "0")}`;

export function quoteFlex(order) {
  const row = (label, value) => ({
    type: "box",
    layout: "horizontal",
    contents: [
      { type: "text", text: label, size: "sm", color: "#777777", flex: 2 },
      { type: "text", text: String(value), size: "sm", wrap: true, flex: 5 }
    ]
  });

  return {
    type: "flex",
    altText: `${orderNo(order.id)} 預估車資 ${order.estimated_fare} 元`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "🚖 OTZ 車隊", weight: "bold", size: "xl" },
          { type: "text", text: "叫車估價", size: "sm", color: "#777777" }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          row("訂單", orderNo(order.id)),
          row("上車", order.pickup),
          row("下車", order.destination),
          row("時間", order.ride_time || "尚未提供"),
          row("人數", order.passengers ? `${order.passengers} 位` : "尚未提供"),
          row("距離", `${Number(order.distance_km).toFixed(1)} 公里`),
          row("車程", `約 ${Math.ceil(Number(order.duration_min))} 分鐘`),
          { type: "separator" },
          row("起跳", `${order.base_fare} 元`),
          row("里程", `${order.mileage_fare} 元`),
          row("時間", `${order.time_fare} 元`),
          row("高速費", `${order.toll || 0} 元（預估）`),
          row("夜間加成", `${order.night_surcharge || 0} 元`),
          {
            type: "text",
            text: `預估車資：約 ${order.estimated_fare} 元`,
            weight: "bold",
            size: "xl",
            align: "center",
            margin: "lg"
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            action: {
              type: "postback",
              label: "確認叫車",
              data: `action=confirm&id=${order.id}`,
              displayText: `確認叫車 ${orderNo(order.id)}`
            }
          },
          {
            type: "button",
            style: "secondary",
            action: {
              type: "postback",
              label: "取消",
              data: `action=cancel&id=${order.id}`,
              displayText: `取消 ${orderNo(order.id)}`
            }
          }
        ]
      }
    }
  };
}

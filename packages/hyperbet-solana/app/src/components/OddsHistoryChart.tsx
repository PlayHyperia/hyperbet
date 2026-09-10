import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface OddsHistoryPoint {
  time: number;
  pct: number;
}

export function OddsHistoryChart({
  data,
}: {
  data: readonly OddsHistoryPoint[];
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data}>
        <XAxis
          dataKey="time"
          tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
          tickLine={false}
          axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
          tickFormatter={(value: number) => {
            const date = new Date(value);
            return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
          }}
        />
        <YAxis
          domain={[0, 100]}
          tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
          tickLine={false}
          axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
          width={40}
          tickFormatter={(value: number) => `${value}%`}
        />
        <Tooltip
          content={({ active, payload }) =>
            active && payload?.length ? (
              <div className="hm-chart-tooltip">
                <span>{payload[0]?.value}%</span>
              </div>
            ) : null
          }
        />
        <ReferenceLine
          y={50}
          stroke="rgba(255,255,255,0.06)"
          strokeDasharray="4 4"
        />
        <Line
          type="monotone"
          dataKey="pct"
          stroke="#e5b84a"
          strokeWidth={2}
          dot={false}
          isAnimationActive
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

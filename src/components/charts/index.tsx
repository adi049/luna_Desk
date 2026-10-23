import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useTheme } from '@/context/app';
import { formatMoney } from '@/lib/money';

export const CHART_COLORS = ['#FF2D95', '#A8D8FF', '#B8F28B', '#FFE27A', '#FFB5D5', '#C7CBD4', '#7C8391'];

function useTokens() {
  const { resolved } = useTheme();
  return {
    grid: resolved === 'dark' ? 'rgba(199,203,212,0.10)' : 'rgba(21,21,29,0.10)',
    axis: resolved === 'dark' ? '#7C8391' : '#7A808C',
    tipBg: resolved === 'dark' ? '#15151D' : '#FFFFFF',
    tipBorder: resolved === 'dark' ? 'rgba(199,203,212,0.18)' : 'rgba(21,21,29,0.14)',
    text: resolved === 'dark' ? '#F8F8FC' : '#101018',
  };
}

interface TooltipPayloadItem {
  name?: string;
  value?: number | string;
  color?: string;
}

function MoneyTooltip({
  active,
  payload,
  label,
  suffixLabel,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string | number;
  suffixLabel?: string;
}) {
  const tokens = useTokens();
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-lg border px-2.5 py-1.5 text-[11px] shadow-lg"
      style={{ background: tokens.tipBg, borderColor: tokens.tipBorder, color: tokens.text }}
    >
      <p className="mb-1 font-medium">{label}</p>
      {payload.map((item, i) => (
        <p key={i} className="num flex items-center gap-1.5" style={{ color: item.color }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: item.color }} aria-hidden />
          {item.name ? `${item.name}: ` : ''}
          {typeof item.value === 'number' ? formatMoney(item.value) : item.value}
          {suffixLabel ?? ''}
        </p>
      ))}
    </div>
  );
}

export function RevenueTrendChart({
  data,
  height = 220,
}: {
  data: { label: string; received: number; invoiced?: number }[];
  height?: number;
}) {
  const tokens = useTokens();
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
        <defs>
          <linearGradient id="rev-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FF2D95" stopOpacity={0.42} />
            <stop offset="100%" stopColor="#FF2D95" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={tokens.grid} vertical={false} />
        <XAxis dataKey="label" tick={{ fill: tokens.axis, fontSize: 10 }} axisLine={false} tickLine={false} />
        <YAxis
          tick={{ fill: tokens.axis, fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => formatMoney(v, { compact: true })}
          width={62}
        />
        <Tooltip content={<MoneyTooltip />} />
        <Area
          type="monotone"
          dataKey="received"
          name="Received"
          stroke="#FF2D95"
          strokeWidth={2}
          fill="url(#rev-fill)"
          animationDuration={700}
          dot={false}
          activeDot={{ r: 3, strokeWidth: 0 }}
        />
        {data.some((d) => typeof d.invoiced === 'number') && (
          <Area
            type="monotone"
            dataKey="invoiced"
            name="Invoiced"
            stroke="#A8D8FF"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            fill="transparent"
            animationDuration={900}
            dot={false}
          />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function MonthlyBars({ data, height = 200 }: { data: { label: string; value: number }[]; height?: number }) {
  const tokens = useTokens();
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
        <CartesianGrid stroke={tokens.grid} vertical={false} />
        <XAxis dataKey="label" tick={{ fill: tokens.axis, fontSize: 10 }} axisLine={false} tickLine={false} />
        <YAxis
          tick={{ fill: tokens.axis, fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => formatMoney(v, { compact: true })}
          width={58}
        />
        <Tooltip content={<MoneyTooltip />} cursor={{ fill: tokens.grid }} />
        <Bar dataKey="value" name="Outstanding" radius={[4, 4, 0, 0]} animationDuration={650} maxBarSize={34}>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.value > 0 ? '#FF2D95' : '#B8F28B'} fillOpacity={entry.value > 0 ? 0.85 : 0.5} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function Donut({
  data,
  height = 200,
  centerLabel,
  centerValue,
}: {
  data: { name: string; value: number; color?: string }[];
  height?: number;
  centerLabel?: string;
  centerValue?: string;
}) {
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="62%"
            outerRadius="88%"
            paddingAngle={2}
            animationDuration={700}
            stroke="none"
          >
            {data.map((entry, i) => (
              <Cell key={entry.name} fill={entry.color ?? CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip content={<MoneyTooltip />} />
          <Legend
            verticalAlign="bottom"
            iconType="circle"
            iconSize={6}
            formatter={(value) => <span className="text-[10.5px] text-muted">{value}</span>}
          />
        </PieChart>
      </ResponsiveContainer>
      {centerValue && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pb-8">
          <span className="num text-base font-semibold text-fg">{centerValue}</span>
          {centerLabel && <span className="text-[9.5px] uppercase tracking-[0.12em] text-faint">{centerLabel}</span>}
        </div>
      )}
    </div>
  );
}

export function TaskTrend({ data, height = 180 }: { data: { label: string; completed: number }[]; height?: number }) {
  const tokens = useTokens();
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid stroke={tokens.grid} vertical={false} />
        <XAxis dataKey="label" tick={{ fill: tokens.axis, fontSize: 10 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: tokens.axis, fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} width={34} />
        <Tooltip
          contentStyle={{
            background: tokens.tipBg,
            border: `1px solid ${tokens.tipBorder}`,
            borderRadius: 8,
            fontSize: 11,
            color: tokens.text,
          }}
          labelStyle={{ color: tokens.axis }}
        />
        <Line
          type="monotone"
          dataKey="completed"
          name="Completed"
          stroke="#B8F28B"
          strokeWidth={2}
          dot={{ r: 2.5, fill: '#B8F28B', strokeWidth: 0 }}
          animationDuration={700}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

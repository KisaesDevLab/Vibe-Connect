import { useMemo } from 'react';
import { scorePassword } from './passwordStrength.js';

export function PasswordStrengthBar({ password }: { password: string }): JSX.Element | null {
  const result = useMemo(() => scorePassword(password), [password]);
  if (password.length === 0) return null;
  const fills = [
    result.score >= 1,
    result.score >= 2,
    result.score >= 3,
    result.score >= 4,
  ];
  const color =
    result.score === 0
      ? 'bg-rose-500'
      : result.score === 1
        ? 'bg-rose-400'
        : result.score === 2
          ? 'bg-amber-400'
          : result.score === 3
            ? 'bg-emerald-500'
            : 'bg-emerald-600';
  return (
    <div className="mt-1">
      <div className="flex gap-1">
        {fills.map((on, i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded ${on ? color : 'bg-slate-200'}`}
            aria-hidden
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] mt-1">
        <span
          className={
            result.score === 0
              ? 'text-rose-600'
              : result.score <= 1
                ? 'text-rose-600'
                : result.score === 2
                  ? 'text-amber-700'
                  : 'text-emerald-700'
          }
        >
          {result.label}
        </span>
        {result.warnings[0] && <span className="text-slate-500 truncate">{result.warnings[0]}</span>}
      </div>
    </div>
  );
}

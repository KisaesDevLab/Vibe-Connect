import { useState } from 'react';

export function ScheduledPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}): JSX.Element {
  const [local, setLocal] = useState(value ? new Date(value).toISOString().slice(0, 16) : '');
  return (
    <div className="flex items-center gap-2 text-xs">
      <label className="text-slate-600">Send later:</label>
      <input
        type="datetime-local"
        className="rounded border border-slate-300 px-2 py-1 text-xs"
        value={local}
        onChange={(e) => {
          setLocal(e.target.value);
          onChange(e.target.value ? new Date(e.target.value).toISOString() : null);
        }}
      />
      {value && (
        <button
          type="button"
          className="text-slate-500 hover:text-slate-800"
          onClick={() => {
            setLocal('');
            onChange(null);
          }}
        >
          clear
        </button>
      )}
    </div>
  );
}

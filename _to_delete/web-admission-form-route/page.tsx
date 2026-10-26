'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Save, Shield } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { getErrorMessage } from '@/lib/error';
import { useAuthStore } from '@/store/authStore';
import { EmptyState, PageHeader, SecondaryButton, TERRACOTTA } from '@/app/admin/payroll/_components/ui';
import AdmissionFormEditor, { formValid } from '../AdmissionFormEditor';
import { apiError, scrollStyle, settingsBody, type AdmissionFormConfig, type AdmissionSettings } from '../admissions.types';

/** Admission form setup, on its own page: opened from Admissions > Settings. */
export default function AdmissionFormSetupPage() {
    const router = useRouter();
    const user = useAuthStore(s => s.user);
    const [saved, setSaved] = useState<AdmissionSettings | null>(null);
    const [form, setForm] = useState<AdmissionFormConfig | null>(null);
    const [loadError, setLoadError] = useState('');
    const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const latest = useRef<AdmissionFormConfig | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const load = useCallback((signal?: AbortSignal) => api.get('/admin/admissions/settings', { signal }).then(res => {
        if (signal?.aborted) return;
        const s = res.data.data.settings as AdmissionSettings;
        setSaved(s); setForm(s.admissionForm); setLoadError('');
    }).catch(err => { if (!signal?.aborted) setLoadError(getErrorMessage(err, 'Could not load the admission form')); }), []);
    useEffect(() => { const c = new AbortController(); void load(c.signal); return () => c.abort(); }, [load]);
    useEffect(() => { latest.current = form; }, [form]);

    const dirty = useMemo(() => !!saved && !!form && JSON.stringify(form) !== JSON.stringify(saved.admissionForm), [saved, form]);
    const valid = !!form && formValid(form);
    const saving = status === 'saving';

    // Saves by itself 2s after the last change, like the settings page.
    const save = async () => {
        if (timer.current) clearTimeout(timer.current);
        if (!saved || !form || saving || !valid || !dirty) return;
        const sent = form;
        setStatus('saving');
        try {
            await api.put('/admin/admissions/settings', settingsBody({ ...saved, admissionForm: sent }, saved.registrationFee));
            const res = await api.get('/admin/admissions/settings');
            const fresh = res.data.data.settings as AdmissionSettings;
            setSaved(fresh);
            // Keep anything changed while saving.
            if (latest.current === sent) setForm(fresh.admissionForm);
            setStatus('saved');
            if (savedTimer.current) clearTimeout(savedTimer.current);
            savedTimer.current = setTimeout(() => setStatus(st => (st === 'saved' ? 'idle' : st)), 2000);
        } catch (err) {
            toast.error(apiError(err, 'Could not save the admission form'));
            setStatus('error');
        }
    };
    useEffect(() => {
        if (!dirty || !valid || saving) return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => { void save(); }, 2000);
        return () => { if (timer.current) clearTimeout(timer.current); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [form, valid]);

    const back = async () => { await save(); router.push('/admin/admissions?view=settings'); };

    if (!user) return null;
    if (user.role === 'SUB_ADMIN' && !user.permissions?.includes('ADMISSIONS')) {
        return <EmptyState icon={Shield} title="Admissions access restricted" text="Contact your admin to request admissions access." />;
    }

    return (
        <div className="h-full min-h-0 min-w-0 w-full flex flex-col gap-3 pb-3">
            <PageHeader title="Admission form setup" subtitle="The form a family fills after the child is selected, and how it is printed." onBack={() => void back()}>
                {form && (
                    <button type="button" onClick={() => void save()} disabled={saving || !valid || (!dirty && status !== 'saved')}
                        className="flex items-center gap-1.5 h-9 px-4 rounded-full text-xs font-semibold text-white disabled:opacity-40 hover:opacity-90 transition-all"
                        style={{ background: status === 'saved' || (!dirty && status === 'idle') ? '#10b981' : TERRACOTTA }}>
                        {saving ? <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                            : status === 'saved' || !dirty ? <CheckCircle2 size={13} /> : <Save size={13} />}
                        {saving ? 'Saving…' : status === 'saved' ? 'Saved' : !dirty ? 'All changes saved' : !valid ? 'Fix the form to save' : 'Save now'}
                    </button>
                )}
            </PageHeader>

            {loadError ? (
                <EmptyState icon={Shield} title="Could not load the admission form" text={loadError}><SecondaryButton onClick={() => void load()}>Retry</SecondaryButton></EmptyState>
            ) : !form ? (
                <p role="status" className="py-16 text-center text-sm text-muted-foreground">Loading...</p>
            ) : !form.enabled ? (
                <EmptyState icon={Shield} title="The admission form is off" text="Turn it on in Admissions settings first.">
                    <SecondaryButton onClick={() => router.push('/admin/admissions?view=settings')}>Go to settings</SecondaryButton>
                </EmptyState>
            ) : (
                <div className="flex-1 min-h-0 overflow-y-auto pr-1 px-1" style={scrollStyle}>
                    <AdmissionFormEditor value={form} onChange={setForm} />
                    {!valid && <p className="mt-3 text-xs text-red-600 dark:text-red-400">Every section and question needs a name, and &quot;Choose one&quot; questions need choices.</p>}
                </div>
            )}
        </div>
    );
}

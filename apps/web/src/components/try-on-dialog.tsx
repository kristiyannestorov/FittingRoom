'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { productsApi } from '@/lib/api/products';

type Step = 'choose' | 'camera' | 'result';

const COUNTDOWN_SECONDS = 3;

const POLL_INTERVAL_MS = 3000;

export interface TryOnDialogPiece {
  slug: string;
  name: string;
  variantId?: string | null;
}

export function TryOnDialog({
  pieces,
  onClose,
}: {
  pieces: TryOnDialogPiece[];
  onClose: () => void;
}) {
  const isOutfit = pieces.length > 1;
  const title = pieces.map((piece) => piece.name).join(' + ');
  const [step, setStep] = useState<Step>('choose');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopCamera, [stopCamera]);
  useEffect(() => () => {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
  }, [photoUrl]);
  useEffect(() => () => {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
  }, [resultUrl]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const [jobId, setJobId] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: (photo: Blob) =>
      productsApi.startTryOn(
        pieces.map(({ slug, variantId }) => ({ slug, variantId: variantId ?? undefined })),
        photo,
      ),
    onSuccess: (view) => setJobId(view.id),
  });

  const job = useQuery({
    queryKey: ['try-on', jobId],
    queryFn: () => productsApi.tryOnStatus(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'done' || status === 'failed' ? false : POLL_INTERVAL_MS;
    },
  });

  const jobStatus = job.data?.status;
  useEffect(() => {
    if (jobStatus !== 'done' || !jobId) return;
    let cancelled = false;
    productsApi
      .tryOnImage(jobId)
      .then((blob) => {
        if (cancelled) return;
        setResultUrl(URL.createObjectURL(blob));
        setShowOriginal(false);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [jobStatus, jobId]);

  const { mutate: runTryOn } = start;
  const submit = useCallback(
    (photo: Blob) => {
      setPhotoUrl(URL.createObjectURL(photo));
      setResultUrl(null);
      setJobId(null);
      setStep('result');
      runTryOn(photo);
    },
    [runTryOn],
  );

  const isWorking = start.isPending || (Boolean(jobId) && !resultUrl && jobStatus !== 'failed' && !job.isError);
  const errorMessage = start.isError
    ? (start.error as Error).message
    : jobStatus === 'failed'
      ? job.data?.error ?? 'Try-on failed, try again with another photo'
      : job.isError
        ? (job.error as Error).message
        : null;
  const progressLabel =
    jobStatus === 'processing'
      ? isOutfit
        ? `Dressing you in ${pieces.length} pieces, one at a time. This takes several minutes, you can keep this window open.`
        : 'Dressing you up. This takes a few minutes, you can keep this window open.'
      : job.data?.position && job.data.position > 1
        ? `In line: ${job.data.position - 1} ${job.data.position === 2 ? 'person' : 'people'} ahead of you.`
        : 'Uploading your photo…';

  const openCamera = async () => {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('This browser cannot open the camera. Upload a photo instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      setStep('camera');
    } catch {
      setCameraError('Camera access was blocked. Allow it in your browser or upload a photo instead.');
    }
  };

  useEffect(() => {
    if (step === 'camera' && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [step]);

  const capture = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        stopCamera();
        submit(blob);
      },
      'image/jpeg',
      0.92,
    );
  }, [stopCamera, submit]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      setCountdown(null);
      capture();
      return;
    }
    const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown, capture]);

  const onFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) submit(file);
  };

  const restart = () => {
    stopCamera();
    setCountdown(null);
    start.reset();
    setJobId(null);
    setStep('choose');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Try on ${title}`}
    >
      <div
        className="flex max-h-full w-full max-w-lg flex-col overflow-y-auto rounded-xl bg-paper p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{isOutfit ? 'Try the outfit on' : 'Try it on'}</h2>
            <p className="text-sm text-black/60">{title}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-black/60 hover:bg-black/5"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {step === 'choose' && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-black/70">
              Take a photo of yourself facing the camera in good light, with{' '}
              {isOutfit ? 'everything these pieces cover' : 'the part of your body this item covers'}{' '}
              fully in frame (down to your ankles for pants) and your arms relaxed at your sides.
              Plain, fitted clothes give the best result.
            </p>
            <button
              type="button"
              onClick={openCamera}
              className="rounded-md bg-ink px-4 py-3 text-sm font-medium text-paper hover:opacity-90"
            >
              Take a photo
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-md border border-black/20 px-4 py-3 text-sm font-medium hover:bg-black/5"
            >
              Upload a photo
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={onFile}
            />
            {cameraError && <p className="text-sm text-red-600">{cameraError}</p>}
            <p className="text-xs text-black/50">
              Your photo is only used to create this preview and is deleted within an hour.
            </p>
          </div>
        )}

        {step === 'camera' && (
          <div className="flex flex-col gap-3">
            <div className="relative overflow-hidden rounded-lg bg-black">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="aspect-[3/4] w-full -scale-x-100 object-cover"
              />
              {countdown !== null && (
                <div className="absolute inset-0 flex items-center justify-center text-7xl font-semibold text-white drop-shadow-lg">
                  {countdown}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={capture}
                disabled={countdown !== null}
                className="flex-1 rounded-md bg-ink px-4 py-3 text-sm font-medium text-paper hover:opacity-90 disabled:opacity-40"
              >
                Capture
              </button>
              <button
                type="button"
                onClick={() => setCountdown(COUNTDOWN_SECONDS)}
                disabled={countdown !== null}
                className="flex-1 rounded-md border border-black/20 px-4 py-3 text-sm font-medium hover:bg-black/5 disabled:opacity-40"
              >
                {COUNTDOWN_SECONDS}s timer
              </button>
            </div>
            <button type="button" onClick={restart} className="text-sm text-black/60 underline">
              Back
            </button>
          </div>
        )}

        {step === 'result' && (
          <div className="flex flex-col gap-3">
            <div className="relative overflow-hidden rounded-lg bg-black/5">
              <img
                src={(showOriginal || !resultUrl ? photoUrl : resultUrl) ?? undefined}
                alt={resultUrl && !showOriginal ? `You wearing ${title}` : 'Your photo'}
                className="w-full object-contain"
              />
              {isWorking && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/40 text-sm text-white">
                  <span
                    className="h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white"
                    aria-hidden
                  />
                  <span className="max-w-xs text-center">{progressLabel}</span>
                </div>
              )}
            </div>

            {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}

            {resultUrl && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowOriginal((v) => !v)}
                  className="flex-1 rounded-md border border-black/20 px-4 py-2 text-sm font-medium hover:bg-black/5"
                >
                  {showOriginal ? 'Show with garment' : 'Show original'}
                </button>
                <a
                  href={resultUrl}
                  download={`${pieces.map((piece) => piece.slug).join('-')}-try-on.jpg`}
                  className="flex-1 rounded-md border border-black/20 px-4 py-2 text-center text-sm font-medium hover:bg-black/5"
                >
                  Save image
                </a>
              </div>
            )}

            <button
              type="button"
              onClick={restart}
              disabled={start.isPending}
              className="rounded-md bg-ink px-4 py-3 text-sm font-medium text-paper hover:opacity-90 disabled:opacity-40"
            >
              Try another photo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

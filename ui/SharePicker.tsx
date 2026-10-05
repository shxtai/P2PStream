/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Divider } from "@components/Divider";
import { FormSwitch } from "@components/FormSwitch";
import { Logger } from "@utils/Logger";
import { Button, closeModal, Forms, Modal, openModal, React, Select, SelectedChannelStore, Slider } from "@webpack/common";

import { captureDesktopSource, listSourcesDetailed, liveApplyTrackConstraints, type P2PSourceInfo, type SourceListState } from "../capture";
import { cl } from "../css";
import { manager } from "../engine";
import { applyProfile, settings } from "../settings";
import { toast } from "../utils";

const logger = new Logger("P2PStream:Picker");

export interface PickerOptions {
    /** Опции, с которыми Discord сам вызвал getDisplayMedia */
    discordOptions: DisplayMediaStreamOptions;
    /** Оригинальный (нетронутый) getDisplayMedia для обычного стрима и веб-фолбэка */
    gdm: (opts: DisplayMediaStreamOptions) => Promise<MediaStream>;
    /** true — gdm вызвал Discord (есть смысл в «Обычном стриме Discord»);
     *  false — вызов из плагина (/p2p-start): Discord-кнопка скрыта */
    fromDiscord?: boolean;
    /** Пользователь выбрал «Обычный стрим Discord», но пикер открыт НЕ из gdm-цепочки
     *  (перехват клика по стоковой кнопке) — вместо резолва потока отдаём управление
     *  наружу (пропускаем один клик в Discord, чтобы он открыл свой пикер). */
    onWantDiscordPicker?: () => void;
}

let openPickerCount = 0;

/** Пикер уже открыт? (чтобы клик по стоковой кнопке не наслоял модалок) */
export function isPickerOpen(): boolean {
    return openPickerCount > 0;
}

/**
 * Открывает пикер. Промис:
 *  - резолвится MediaStream, если пользователь выбрал «Обычный стрим Discord»;
 *  - reject(NotAllowedError) при отмене и после успешного старта P2P.
 */
export function openSharePicker(options: PickerOptions): Promise<MediaStream> {
    return new Promise((resolve, reject) => {
        const notAllowed = () => {
            const e = new Error("P2PStream: cancelled");
            e.name = "NotAllowedError";
            return e;
        };
        let settled = false;
        const ok = (s: MediaStream) => {
            if (settled) return;
            settled = true;
            resolve(s);
        };
        const fail = () => {
            if (settled) return;
            settled = true;
            reject(notAllowed());
        };

        openPickerCount++;
        const settleAndCloseCount = () => {
            openPickerCount = Math.max(0, openPickerCount - 1);
        };

        const key = openModal(
            props => (
                <SharePickerModal
                    modalProps={props}
                    options={options}
                    onDefaultStream={s => { ok(s); props.onClose(); }}
                    onCancel={() => { fail(); props.onClose(); }}
                />
            ),
            {
                onCloseRequest: () => {
                    fail();
                    closeModal(key);
                },
                onCloseCallback: () => {
                    fail();
                    settleAndCloseCount();
                }
            }
        );
    });
}

const RES_OPTIONS = [
    { value: "480", label: "480p" },
    { value: "720", label: "720p" },
    { value: "1080", label: "1080p" },
    { value: "1440", label: "1440p" },
    { value: "2160", label: "2160p" },
    { value: "native", label: "Родное" }
];
const FPS_OPTIONS = ["15", "30", "60", "90", "120", "144", "240"];

function RadioRow({ options, value, onChange }: {
    options: Array<{ value: string; label: string }>;
    value: string;
    onChange(v: string): void;
}) {
    return (
        <div className={cl("picker-seg")}>
            {options.map(o => (
                <button
                    key={o.value}
                    className={cl("pill-btn", { active: String(value) === String(o.value) })}
                    onClick={() => onChange(o.value)}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function SharePickerModal({
    modalProps,
    options,
    onDefaultStream,
    onCancel
}: {
    modalProps: { transitionState: number; onClose(): void; [k: string]: any };
    options: PickerOptions;
    onDefaultStream(s: MediaStream): void;
    onCancel(): void;
}) {
    const [, force] = React.useReducer((x: number) => x + 1, 0);
    const [srcState, setSrcState] = React.useState<SourceListState | null>(null); // null = ещё грузится
    const sources = srcState?.status === "ok" ? srcState.sources : null;
    const [selected, setSelected] = React.useState<P2PSourceInfo | null>(null);
    const [preview, setPreview] = React.useState<MediaStream | null>(null);
    const [previewIsGdm, setPreviewIsGdm] = React.useState(false);
    const [audioWarn, setAudioWarn] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [showAdvanced, setShowAdvanced] = React.useState(false);
    const videoRef = React.useRef<HTMLVideoElement | null>(null);
    /** текущий предпросмотр и флаг «поток передан движку/Discord» — для очистки при закрытии */
    const previewRef = React.useRef<MediaStream | null>(null);
    const handedOffRef = React.useRef(false);
    previewRef.current = preview;

    // Закрытие пикера (Esc, клик мимо, крестик) раньше НЕ гасило захват
    // предпросмотра — экран продолжал захватываться в фоне
    React.useEffect(() => () => {
        if (!handedOffRef.current) stopPreview(previewRef.current);
    }, []);

    const inVoice = !!SelectedChannelStore.getVoiceChannelId?.();

    React.useEffect(() => {
        let alive = true;
        listSourcesDetailed().then(res => {
            if (alive) setSrcState(res);
            if (res.status !== "ok") logger.warn("Источники:", res.status, res.message ?? "");
        });
        return () => { alive = false; };
    }, []);

    function refreshSources(): void {
        setSrcState(null);
        void listSourcesDetailed().then(res => setSrcState(res));
    }

    React.useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = preview;
        const p = v.play();
        if (p) p.catch(() => { /* ignore */ });
    }, [preview]);

    function stopPreview(stream: MediaStream | null): void {
        stream?.getTracks().forEach(t => {
            try { t.stop(); } catch { /* ignore */ }
        });
    }

    const captureOpts = () => ({
        fps: Number(settings.store.fps) || 60,
        height: String(settings.store.resolution) === "native" ? null : Number(settings.store.resolution),
        // «native»: берём и системный loopback — он станет фолбэком, если нативный per-app звук не заведётся
        audio: String(settings.store.audioMode) !== "off"
    });

    async function selectSource(src: P2PSourceInfo): Promise<void> {
        if (busy) return;
        setBusy(true);
        setAudioWarn(false);
        stopPreview(preview);
        setPreview(null);
        setSelected(src);
        try {
            const stream = await captureDesktopSource(src.id, captureOpts());
            if (!stream) {
                // прямой захват не удался — честный путь через системный пикер (Vesktop)
                toast("Прямой захват не удался — открываю системный пикер", "critical");
                await pickSourceWeb();
                return;
            }
            setAudioWarn(
                String(settings.store.audioMode) !== "off" && stream.getAudioTracks().length === 0
            );
            setPreviewIsGdm(false);
            setPreview(stream);

            const track = stream.getVideoTracks()[0];
            track?.addEventListener("ended", () => {
                setPreview(null);
                setSelected(null);
            });
        } finally {
            setBusy(false);
        }
    }

    async function pickSourceWeb(): Promise<void> {
        const { gdm } = options;
        try {
            const fps = Number(settings.store.fps) || 60;
            const res = String(settings.store.resolution);
            const video: MediaTrackConstraints = { frameRate: fps };
            if (res !== "native") video.height = Number(res);
            const stream = await gdm({
                video,
                audio: String(settings.store.audioMode) !== "off"
                    ? { restrictOwnAudio: true } as MediaTrackConstraints
                    : false,
                systemAudio: "include",
                surfaceSwitching: "include",
                selfBrowserSurface: "exclude",
                monitorTypeSurfaces: "include"
            } as DisplayMediaStreamOptions);
            stopPreview(preview);
            setAudioWarn(
                String(settings.store.audioMode) !== "off" && stream.getAudioTracks().length === 0
            );
            setPreviewIsGdm(true);
            setPreview(stream);
            setSelected({ id: "", name: stream.getVideoTracks()[0]?.label || "Источник", thumb: null, isScreen: false });
            stream.getVideoTracks()[0]?.addEventListener("ended", () => {
                setPreview(null);
                setSelected(null);
            });
        } catch (e: any) {
            if (e?.name !== "NotAllowedError") toast("Не удалось выбрать источник", "critical");
        }
    }

    function onQualityChanged(): void {
        force();
        const track = preview?.getVideoTracks()[0];
        if (track) void liveApplyTrackConstraints(track);
    }

    function quickProfile(p: "games" | "movies"): void {
        applyProfile(p);
        settings.store.profile = p;
        onQualityChanged();
    }

    async function startP2P(): Promise<void> {
        if (!preview || busy) return;
        setBusy(true);
        try {
            const track = preview.getVideoTracks()[0];
            if (track) await liveApplyTrackConstraints(track);
            handedOffRef.current = true;
            modalProps.onClose();
            // владение потоком передаётся движку; локальную ссылку не гасим.
            // Для gdm-источника selected фиктивный (id "") — передаём null:
            // нативный звук пойдёт как «система без Discord»
            const src = previewIsGdm ? null : selected;
            setPreview(null);
            setSelected(null);
            await manager.startShareWithCapture(preview, src);
            onCancel(); // Discord'у сообщаем «отмену захвата» — его Go Live не стартует
        } finally {
            setBusy(false);
        }
    }

    async function startDefaultStream(): Promise<void> {
        if (busy) return;
        setBusy(true);
        try {
            // Пикер открыт перехватом стоковой кнопки: отдаём ход Discord —
            // он откроет свой пикер и запустит обычный стрим сам
            if (options.onWantDiscordPicker) {
                modalProps.onClose();
                options.onWantDiscordPicker();
                return;
            }
            // Нативный захват уже есть — отдаём его Discord'у, лишний пикер не показываем
            if (preview && !previewIsGdm) {
                const s = preview;
                handedOffRef.current = true;
                setPreview(null);
                setSelected(null);
                modalProps.onClose();
                onDefaultStream(s);
                return;
            }
            // веб-фолбэк или ещё не захватывали: честный путь через системный пикер
            const s = await options.gdm(options.discordOptions);
            stopPreview(preview);
            handedOffRef.current = true;
            setPreview(null);
            modalProps.onClose();
            onDefaultStream(s);
        } catch (e: any) {
            if (e?.name !== "NotAllowedError") toast("Не удалось начать обычный стрим", "critical");
        } finally {
            setBusy(false);
        }
    }

    function close(): void {
        stopPreview(preview);
        modalProps.onClose();
    }

    const fpsVal = String(settings.store.fps);
    const resVal = String(settings.store.resolution);
    const profile = String(settings.store.profile);

    return (
        <Modal
            {...modalProps}
            size="lg"
            title={(
                <div className={cl("picker-title")}>
                    <span>Трансляция экрана</span>
                    <span className={cl("p2p-badge")}>P2P</span>
                </div>
            )}
        >
            <div className={cl("picker-body")}>
                {srcState === null && (
                    <div className={cl("picker-preview-empty")}><span>Загружаем источники…</span></div>
                )}

                {srcState !== null && (
                    <>
                        {srcState.status !== "ok" ? (
                            // нативный канал недоступен/пуст — конкретная причина + запасные пути (без тупиков)
                            <div className={cl("picker-row")}>
                                <span className={cl("picker-hint")}>{srcState.message}</span>
                                <div style={{ display: "flex", gap: "8px" }}>
                                    <Button
                                        size={Button.Sizes?.SMALL ?? "small"}
                                        color={Button.Colors?.PRIMARY ?? "brand"}
                                        onClick={refreshSources}
                                    >
                                        Обновить список
                                    </Button>
                                    <Button
                                        size={Button.Sizes?.SMALL ?? "small"}
                                        color={Button.Colors?.GREEN ?? "green"}
                                        onClick={() => void pickSourceWeb()}
                                    >
                                        {preview ? "Сменить источник" : "Выбрать экран или окно"}
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <div className={cl("picker-sources")}>
                                {srcState.sources.map(src => (
                                    <div
                                        key={src.id}
                                        className={cl("picker-source")}
                                        data-selected={selected?.id === src.id}
                                        data-screen={src.isScreen}
                                        onClick={() => void selectSource(src)}
                                    >
                                        {src.thumb
                                            ? <img src={src.thumb} alt="" draggable={false} />
                                            : <div className={cl("picker-source-empty")}><span>нет превью</span></div>}
                                        <span className={cl("picker-source-name")}>{src.isScreen ? "🖥 " : ""}{src.name}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {preview ? (
                            <div className={cl("picker-preview")}>
                                <video ref={videoRef} className={cl("picker-video")} autoPlay muted playsInline />
                            </div>
                        ) : (
                            <div className={cl("picker-preview-empty")}>
                                <span>Выберите экран или окно — предпросмотр появится здесь</span>
                            </div>
                        )}
                        {audioWarn && (
                            <span className={cl("picker-hint")}>
                                Системный звук недоступен для этого источника — если и нативный звук не заработает, эфир пойдёт без звука
                            </span>
                        )}
                    </>
                )}

                <Divider />

                {!inVoice && (
                    <span className={cl("picker-hint")}>
                        Подключитесь к голосовому каналу, чтобы зрители увидели эфир
                    </span>
                )}

                <Forms.FormTitle tag="h5">Качество</Forms.FormTitle>
                <div className={cl("picker-grid")}>
                    <div>
                        <Forms.FormTitle tag="h5" className={cl("picker-label")}>Разрешение</Forms.FormTitle>
                        <RadioRow options={RES_OPTIONS} value={resVal} onChange={v => { (settings.store as any).resolution = v; onQualityChanged(); }} />
                    </div>
                    <div>
                        <Forms.FormTitle tag="h5" className={cl("picker-label")}>Частота кадров</Forms.FormTitle>
                        <RadioRow options={FPS_OPTIONS.map(f => ({ value: f, label: f }))} value={fpsVal} onChange={v => { (settings.store as any).fps = v; onQualityChanged(); }} />
                    </div>
                    <div>
                        <Forms.FormTitle tag="h5" className={cl("picker-label")}>Режим (как «Stream Mode» у Discord)</Forms.FormTitle>
                        <div className={cl("picker-seg")}>
                            <button className={cl("pill-btn", { active: profile === "games" })} onClick={() => quickProfile("games")}>Игры</button>
                            <button className={cl("pill-btn", { active: profile === "movies" })} onClick={() => quickProfile("movies")}>Кино</button>
                        </div>
                        <span className={cl("picker-hint")}>
                            Игры — плавное движение; Кино — чёткая картинка. До 240 FPS стабильнее всего при захвате всего экрана.
                        </span>
                    </div>
                </div>

                <div className={cl("picker-row")}>
                    <FormSwitch
                        title="Звук трансляции"
                        description={
                            settings.store.audioMode === "off"
                                ? "Звук отключён"
                                : settings.store.audioMode === "native"
                                    ? "Умный звук (Windows): окно — звук только этого приложения; экран — вся система, кроме Discord"
                                    : "Системный звук; звук самого Discord в эфир не попадает"
                        }
                        value={String(settings.store.audioMode) !== "off"}
                        onChange={(v: boolean) => {
                            settings.store.audioMode = v ? "native" : "off";
                            force();
                        }}
                        hideBorder={false}
                    />
                </div>

                <button className={cl("picker-advanced-toggle")} onClick={() => setShowAdvanced(a => !a)}>
                    {showAdvanced ? "Свернуть дополнительные настройки" : "Дополнительные настройки (кодек, битрейт)"}
                </button>
                {showAdvanced && (
                    <div className={cl("picker-advanced")}>
                        <div className={cl("picker-grid")}>
                            <div>
                                <Forms.FormTitle tag="h5" className={cl("picker-label")}>Кодек</Forms.FormTitle>
                                <Select
                                    options={[
                                        { label: "Авто", value: "auto" },
                                        { label: "H.264", value: "h264" },
                                        { label: "VP9", value: "vp9" },
                                        { label: "AV1", value: "av1" }
                                    ]}
                                    isSelected={v => String(settings.store.codec) === v}
                                    select={v => { settings.store.codec = v; force(); }}
                                    serialize={v => String(v)}
                                />
                            </div>
                            <div>
                                <Forms.FormTitle tag="h5" className={cl("picker-label")}>Видеобитрейт: {settings.store.videoBitrate} Мбит/с</Forms.FormTitle>
                                <Slider
                                    minValue={2}
                                    maxValue={100}
                                    initialValue={Number(settings.store.videoBitrate) || 25}
                                    markers={[2, 5, 10, 15, 20, 25, 30, 40, 50, 65, 80, 100]}
                                    stickToMarkers={false}
                                    onValueChange={(v: number) => { settings.store.videoBitrate = Math.round(v); force(); }}
                                />
                            </div>
                        </div>
                    </div>
                )}

                <span className={cl("picker-hint")}>
                    Задержка 30–80 мс · до 5 зрителей · служебные сообщения тихие (@silent) и удаляются сами
                </span>

                <div className={cl("picker-footer")}>
                    {options.fromDiscord !== false && (
                        <Button
                            size={Button.Sizes?.MEDIUM ?? "medium"}
                            color={Button.Colors?.PRIMARY ?? "brand"}
                            disabled={busy}
                            onClick={() => void startDefaultStream()}
                        >
                            Обычный стрим Discord
                        </Button>
                    )}
                    <Button
                        size={Button.Sizes?.LARGE ?? "large"}
                        color={Button.Colors?.GREEN ?? "green"}
                        disabled={!preview || busy}
                        onClick={() => void startP2P()}
                    >
                        {busy ? "Запуск…" : "Начать P2P-трансляцию"}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

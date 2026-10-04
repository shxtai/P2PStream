/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Divider } from "@components/Divider";
import { FormSwitch } from "@components/FormSwitch";
import { Button, Forms, Modal, openModal, React, Select, Slider } from "@webpack/common";

import { cl } from "../css";
import { applyCaptureConstraints, manager } from "../engine";
import { applyProfile, settings } from "../settings";
import { toast } from "../utils";

interface PickerOptions {
    /** Запустить обычный (дефолтный) стрим Discord вместо P2P */
    startDefault(): void;
}

export function openSharePicker(options: PickerOptions): void {
    openModal(
        props => <SharePickerModal modalProps={props} startDefault={options.startDefault} />,
        { onCloseCallback: () => { /* noop */ } }
    );
}

const FPS_OPTIONS = ["30", "48", "60", "72", "90", "120", "144", "240"];

function SharePickerModal({
    modalProps,
    startDefault
}: {
    modalProps: { transitionState: number; onClose(): void; [k: string]: any };
    startDefault(): void;
}) {
    const [, force] = React.useReducer((x: number) => x + 1, 0);
    const [preview, setPreview] = React.useState<MediaStream | null>(null);
    const [sourceName, setSourceName] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const videoRef = React.useRef<HTMLVideoElement | null>(null);

    // предпросмотр захвата
    React.useEffect(() => {
        const v = videoRef.current;
        if (!v || !preview) return;
        v.srcObject = preview;
        const p = v.play();
        if (p) p.catch(() => { /* ignore */ });
    }, [preview]);

    const stopPreview = React.useCallback((stream: MediaStream | null) => {
        stream?.getTracks().forEach(t => {
            try { t.stop(); } catch { /* ignore */ }
        });
    }, []);

    async function pickSource(): Promise<void> {
        const gdm = navigator.mediaDevices?.getDisplayMedia;
        if (!gdm) {
            toast("Захват экрана недоступен в этом клиенте", "critical");
            return;
        }
        try {
            const stream = await gdm.call(navigator.mediaDevices, {
                video: true,
                audio: settings.store.audioMode === "system" ? { restrictOwnAudio: true } : false,
                systemAudio: "include",
                surfaceSwitching: "include",
                selfBrowserSurface: "exclude",
                monitorTypeSurfaces: "include"
            } as DisplayMediaStreamOptions);

            setPreview(prev => {
                if (prev !== stream) stopPreview(prev);
                return stream;
            });
            setSourceName(stream.getVideoTracks()[0]?.label || "Источник");

            const track = stream.getVideoTracks()[0];
            track?.addEventListener("ended", () => {
                setPreview(null);
                setSourceName(null);
            });
        } catch (e: any) {
            if (e?.name !== "NotAllowedError") {
                toast("Не удалось выбрать источник", "critical");
            }
        }
    }

    async function startP2P(): Promise<void> {
        if (!preview || busy) return;
        setBusy(true);
        try {
            const track = preview.getVideoTracks()[0];
            if (track) await applyCaptureConstraints(track);
        } catch { /* ignore */ }
        modalProps.onClose();
        // владение потоком передаётся движку
        setPreview(null);
        await manager.startShareWithCapture(preview);
    }

    function startDefaultStream(): void {
        stopPreview(preview);
        setPreview(null);
        modalProps.onClose();
        startDefault();
    }

    function close(): void {
        stopPreview(preview);
        setPreview(null);
        modalProps.onClose();
    }

    function set<K extends keyof typeof settings.store>(key: K, value: (typeof settings.store)[K]): void {
        (settings.store as any)[key] = value;
        force();
    }

    const profile = String(settings.store.profile);

    function quickProfile(p: "games" | "movies"): void {
        applyProfile(p);
        settings.store.profile = p;
        force();
    }

    const videoTrack = preview?.getVideoTracks()[0];

    return (
        <Modal
            {...modalProps}
            size="lg"
            title={(
                <div className={cl("picker-title")}>
                    <span>Трансляция</span>
                    <span className={cl("p2p-badge")}>P2P</span>
                </div>
            )}
        >
            <div className={cl("picker-body")}>
                <Forms.FormTitle tag="h5">Что демонстрировать</Forms.FormTitle>
                {preview ? (
                    <div className={cl("picker-preview")}>
                        <video ref={videoRef} className={cl("picker-video")} autoPlay muted playsInline />
                        <div className={cl("picker-source-name")}>{sourceName}</div>
                    </div>
                ) : (
                    <div className={cl("picker-preview-empty")}>
                        <span>Экран или окно не выбрано</span>
                    </div>
                )}
                <div className={cl("picker-row")}>
                    <Button
                        size={Button.Sizes?.SMALL ?? "small"}
                        color={Button.Colors?.PRIMARY ?? "brand"}
                        onClick={() => void pickSource()}
                    >
                        {preview ? "Сменить источник" : "Выбрать экран или окно"}
                    </Button>
                    {videoTrack && (
                        <span className={cl("picker-hint")}>
                            {videoTrack.getSettings().frameRate
                                ? `~${Math.round(videoTrack.getSettings().frameRate ?? 0)} FPS захват`
                                : ""}
                        </span>
                    )}
                </div>

                <Divider />

                <Forms.FormTitle tag="h5">Параметры трансляции</Forms.FormTitle>
                <div className={cl("picker-grid")}>
                    <div>
                        <Forms.FormTitle tag="h5" className={cl("picker-label")}>Разрешение</Forms.FormTitle>
                        <Select
                            options={[
                                { label: "720p", value: "720" },
                                { label: "1080p", value: "1080" },
                                { label: "1440p", value: "1440" },
                                { label: "2160p (4K)", value: "2160" },
                                { label: "Родное", value: "native" },
                            ]}
                            isSelected={v => String(settings.store.resolution) === v}
                            select={v => set("resolution", v)}
                            serialize={v => String(v)}
                        />
                    </div>
                    <div>
                        <Forms.FormTitle tag="h5" className={cl("picker-label")}>Частота кадров</Forms.FormTitle>
                        <Select
                            options={FPS_OPTIONS.map(f => ({ label: `${f} FPS`, value: f }))}
                            isSelected={v => String(settings.store.fps) === v}
                            select={v => set("fps", v)}
                            serialize={v => String(v)}
                        />
                    </div>
                    <div>
                        <Forms.FormTitle tag="h5" className={cl("picker-label")}>Кодек</Forms.FormTitle>
                        <Select
                            options={[
                                { label: "Авто", value: "auto" },
                                { label: "H.264", value: "h264" },
                                { label: "VP9", value: "vp9" },
                                { label: "AV1", value: "av1" },
                            ]}
                            isSelected={v => String(settings.store.codec) === v}
                            select={v => set("codec", v)}
                            serialize={v => String(v)}
                        />
                    </div>
                    <div>
                        <Forms.FormTitle tag="h5" className={cl("picker-label")}>Тип контента</Forms.FormTitle>
                        <div className={cl("picker-seg")}>
                            <button
                                className={cl("pill-btn", { active: profile === "games" })}
                                onClick={() => quickProfile("games")}
                            >
                                Игры
                            </button>
                            <button
                                className={cl("pill-btn", { active: profile === "movies" })}
                                onClick={() => quickProfile("movies")}
                            >
                                Кино
                            </button>
                        </div>
                    </div>
                </div>

                <div className={cl("picker-row")}>
                    <span className={cl("picker-label")}>Видеобитрейт: {settings.store.videoBitrate} Мбит/с</span>
                    <div className={cl("picker-slider")}>
                        <Slider
                            minValue={2}
                            maxValue={100}
                            initialValue={Number(settings.store.videoBitrate) || 25}
                            markers={[2, 5, 10, 15, 20, 25, 30, 40, 50, 65, 80, 100]}
                            stickToMarkers={false}
                            onValueChange={(v: number) => set("videoBitrate", Math.round(v))}
                        />
                    </div>
                </div>

                <div className={cl("picker-row")}>
                    <FormSwitch
                        title="Звук трансляции"
                        description="Системный звук; звук самого Discord в эфир не попадает"
                        value={settings.store.audioMode === "system"}
                        onChange={(v: boolean) => set("audioMode", v ? "system" : "off")}
                        hideBorder={false}
                    />
                </div>

                <span className={cl("picker-hint")}>
                    Задержка 30–80 мс · до 5 зрителей · сигналинг невидим (служебные сообщения удаляются сами)
                </span>

                <div className={cl("picker-footer")}>
                    <Button
                        size={Button.Sizes?.MEDIUM ?? "medium"}
                        color={Button.Colors?.PRIMARY ?? "brand"}
                        onClick={startDefaultStream}
                    >
                        Обычный стрим Discord
                    </Button>
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

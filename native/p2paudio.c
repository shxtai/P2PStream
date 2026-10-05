/*
 * p2paudio — WASAPI Process Loopback helper for the Vencord plugin P2PStream.
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Захват звука процесса (или всей системы, КРОМЕ дерева процесса Discord)
 * через WASAPI Process Loopback — тот же механизм, что использует сам Discord.
 * Требуется Windows 10 2004 (build 19041) или новее.
 *
 * Использование:
 *   p2paudio.exe include-pid <pid>     — захват звука дерева процесса pid
 *   p2paudio.exe include-hwnd <hwnd>   — захват звука окна (hwnd -> pid)
 *   p2paudio.exe exclude-pid <pid>     — захват всей системы, кроме дерева pid
 *
 * stdout: сырой PCM float32 LE, 48000 Hz, 2 канала (бинарный поток).
 * stderr: "READY" после старта захвата, "ERR <описание>" при ошибке.
 *
 * Сборка (mingw-w64 или zig cc):
 *   zig cc -target x86_64-windows-gnu -O2 -s -o p2paudio.exe p2paudio.c -lole32
 *
 * Примечание: типы AUDIOCLIENT_ACTIVATION_PARAMS отсутствуют в заголовках
 * mingw-w64 — объявлены вручную; ActivateAudioInterfaceAsync берётся из
 * mmdevapi.dll динамически.
 */

#define WIN32_LEAN_AND_MEAN
#define INITGUID
#include <windows.h>
#include <objbase.h>
#include <propidl.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <io.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

/* ------------------------------------------------------------------ */
/* Ручные объявления (нет в заголовках mingw-w64)                      */
/* ------------------------------------------------------------------ */

/* VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK из audioclientactivationparams.h.
 * Раньше здесь стоял выдуманный GUID "{2E6BC2EB-...}" — такого устройства нет,
 * и ActivateAudioInterfaceAsync сразу отвечал E_ILLEGAL_METHOD_CALL (0x8000000E). */
static LPCWSTR VC_VirtualAudioDevicePath(void) {
    return L"VAD\\Process_Loopback";
}

/* {94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90} — IAgileObject. Раньше здесь была опечатка
 * (B0A0 вместо C0FF): Windows не находила IAgileObject у обработчика и
 * ActivateAudioInterfaceAsync сразу отвечал E_ILLEGAL_METHOD_CALL (0x8000000E) —
 * «умный звук» не работал ни у кого. */
static const IID VC_IID_IAgileObject =
    { 0x94ea2b94, 0xe9cc, 0x49e0, { 0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90 } };

typedef enum VC_AUDIOCLIENT_ACTIVATION_TYPE {
    VC_AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
    VC_AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
} VC_AUDIOCLIENT_ACTIVATION_TYPE;

typedef enum VC_PROCESS_LOOPBACK_MODE {
    VC_PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
    VC_PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
} VC_PROCESS_LOOPBACK_MODE;

/* Порядок полей — как в audioclientactivationparams.h: СНАЧАЛА pid, потом режим.
 * Раньше было наоборот: Windows видела pid = 0/1 и режим = номер процесса,
 * активация отвечала E_INVALIDARG (0x80070057). */
typedef struct VC_AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
    DWORD TargetProcessId;
    VC_PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} VC_AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;

typedef struct VC_AUDIOCLIENT_ACTIVATION_PARAMS {
    VC_AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
    union {
        VC_AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    } u;
} VC_AUDIOCLIENT_ACTIVATION_PARAMS;

/* Process loopback работает ТОЛЬКО в shared-режиме. Раньше здесь был
 * самодельный AUDCLNT_SHAREMODE_CAPTURE = 1 — а 1 это AUDCLNT_SHAREMODE_EXCLUSIVE. */
#define VC_SHAREMODE_SHARED ((AUDCLNT_SHAREMODE)0)

typedef HRESULT (WINAPI *PFN_ActivateAudioInterfaceAsync)(
    LPCWSTR deviceInterfacePath,
    REFIID riid,
    PROPVARIANT *activationParams,
    void *completionHandler,
    void **activateOperation
);

/* C-представление IActivateAudioInterfaceAsyncOperation: слоты = IUnknown + GetActivateResult */
typedef struct VC_AsyncOpVtbl {
    HRESULT (STDMETHODCALLTYPE *QueryInterface)(void *, REFIID, void **);
    ULONG   (STDMETHODCALLTYPE *AddRef)(void *);
    ULONG   (STDMETHODCALLTYPE *Release)(void *);
    HRESULT (STDMETHODCALLTYPE *GetActivateResult)(void *, HRESULT *, void **);
} VC_AsyncOpVtbl;

/* ------------------------------------------------------------------ */
/* COM-обработчик активации (IActivateAudioInterfaceCompletionHandler) */
/* ------------------------------------------------------------------ */

typedef struct VC_HandlerVtbl {
    HRESULT (STDMETHODCALLTYPE *QueryInterface)(void *, REFIID, void **);
    ULONG   (STDMETHODCALLTYPE *AddRef)(void *);
    ULONG   (STDMETHODCALLTYPE *Release)(void *);
    HRESULT (STDMETHODCALLTYPE *ActivateCompleted)(void *, void *);
} VC_HandlerVtbl;

/* IAgileObject — маркер без собственных методов: на него отвечаем ТЕМ ЖЕ
 * указателем. Раньше QI возвращал self+8 (второй vtable), а AddRef/Release
 * трактовали его как весь объект и делали InterlockedIncrement по чужой памяти
 * на стеке — активация получала испорченный обработчик (0x8000000E). */
typedef struct VC_Handler {
    VC_HandlerVtbl *handlerVtbl;
    HANDLE done;
    LONG   refs;
    /* free-threaded marshaler (как FtmBase в WRL-примере Microsoft): без IMarshal
     * от FTM ActivateAudioInterfaceAsync считает обработчик не-agile и сразу
     * отвечает E_ILLEGAL_METHOD_CALL (0x8000000E) */
    IUnknown *ftm;
} VC_Handler;

static HRESULT STDMETHODCALLTYPE VC_QI(void *self, REFIID riid, void **out) {
    VC_Handler *h = (VC_Handler *)self;
    if (!out) return E_POINTER;
    *out = NULL;
    if (IsEqualGUID(riid, &IID_IUnknown) ||
        IsEqualGUID(riid, &IID_IActivateAudioInterfaceCompletionHandler) ||
        IsEqualGUID(riid, &VC_IID_IAgileObject)) {
        *out = self;
        InterlockedIncrement(&h->refs);
        return S_OK;
    }
    if (IsEqualGUID(riid, &IID_IMarshal) && h->ftm) {
        return h->ftm->lpVtbl->QueryInterface(h->ftm, riid, out);
    }
    return E_NOINTERFACE;
}

static ULONG STDMETHODCALLTYPE VC_AddRef(void *self) {
    VC_Handler *h = (VC_Handler *)self;
    return InterlockedIncrement(&h->refs);
}

static ULONG STDMETHODCALLTYPE VC_Release(void *self) {
    VC_Handler *h = (VC_Handler *)self;
    return InterlockedDecrement(&h->refs);
}

static HRESULT STDMETHODCALLTYPE VC_ActivateCompleted(void *self, void *op) {
    VC_Handler *h = (VC_Handler *)self;
    (void)op;
    SetEvent(h->done);
    return S_OK;
}

static VC_HandlerVtbl g_handlerVtbl = { VC_QI, VC_AddRef, VC_Release, VC_ActivateCompleted };

/* ------------------------------------------------------------------ */
/* Утилиты                                                             */
/* ------------------------------------------------------------------ */

/* этап активации для сообщения об ошибке (диагностика без отладчика) */
static const char *g_stage = "init";

static void fail(const char *msg) {
    fprintf(stderr, "ERR %s\n", msg);
    fflush(stderr);
    exit(3);
}

static BOOL isWin10_2004(void) {
    typedef LONG (WINAPI *PFN_RtlGetVersion)(PRTL_OSVERSIONINFOW);
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    PFN_RtlGetVersion p;
    RTL_OSVERSIONINFOW vi;
    if (!ntdll) return FALSE;
    p = (PFN_RtlGetVersion)(void *)GetProcAddress(ntdll, "RtlGetVersion");
    if (!p) return FALSE;
    ZeroMemory(&vi, sizeof(vi));
    vi.dwOSVersionInfoSize = sizeof(vi);
    if (p(&vi) != 0) return FALSE;
    return vi.dwMajorVersion > 10 ||
           (vi.dwMajorVersion == 10 && vi.dwMinorVersion == 0 && vi.dwBuildNumber >= 19041);
}

/* ------------------------------------------------------------------ */
/* Активация process loopback                                          */
/* ------------------------------------------------------------------ */

static HRESULT activateLoopback(DWORD pid, VC_PROCESS_LOOPBACK_MODE mode, void **outAudioClient) {
    HRESULT hr;
    VC_Handler handler;
    void *op = NULL;
    void *unk = NULL;
    HRESULT hrActivate = E_FAIL;
    HMODULE mmdevapi;
    PFN_ActivateAudioInterfaceAsync pActivate;
    PROPVARIANT pv;
    VC_AUDIOCLIENT_ACTIVATION_PARAMS params;
    VC_AsyncOpVtbl *vt;

    mmdevapi = LoadLibraryW(L"mmdevapi.dll");
    if (!mmdevapi) return HRESULT_FROM_WIN32(GetLastError());
    pActivate = (PFN_ActivateAudioInterfaceAsync)(void *)GetProcAddress(mmdevapi, "ActivateAudioInterfaceAsync");
    if (!pActivate) return E_NOTIMPL;

    ZeroMemory(&handler, sizeof(handler));
    handler.handlerVtbl = &g_handlerVtbl;
    handler.refs = 1;
    handler.done = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (!handler.done) return HRESULT_FROM_WIN32(GetLastError());
    g_stage = "CoCreateFreeThreadedMarshaler";
    hr = CoCreateFreeThreadedMarshaler((IUnknown *)&handler, &handler.ftm);
    if (FAILED(hr)) { CloseHandle(handler.done); return hr; }

    ZeroMemory(&params, sizeof(params));
    params.ActivationType = VC_AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.u.ProcessLoopbackParams.ProcessLoopbackMode = mode;
    params.u.ProcessLoopbackParams.TargetProcessId = pid;

    ZeroMemory(&pv, sizeof(pv));
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof(params);
    pv.blob.pBlobData = (BYTE *)&params;

    g_stage = "ActivateAudioInterfaceAsync";
    hr = pActivate(VC_VirtualAudioDevicePath(), &IID_IAudioClient,
                   &pv, &handler, &op);
    if (FAILED(hr)) goto done;
    g_stage = "wait";

    if (WaitForSingleObject(handler.done, 10000) != WAIT_OBJECT_0) {
        hr = E_FAIL;
        goto done;
    }

    if (!op) { hr = E_POINTER; goto done; }
    vt = *(VC_AsyncOpVtbl **)op;
    g_stage = "GetActivateResult";
    hr = vt->GetActivateResult(op, &hrActivate, &unk);
    if (FAILED(hr)) goto done;
    g_stage = "activate result";
    hr = hrActivate;
    if (FAILED(hr) || !unk) goto done;

    hr = ((IUnknown *)unk)->lpVtbl->QueryInterface((IUnknown *)unk, &IID_IAudioClient, outAudioClient);

done:
    if (unk) ((IUnknown *)unk)->lpVtbl->Release((IUnknown *)unk);
    if (op) {
        vt = *(VC_AsyncOpVtbl **)op;
        vt->Release(op);
    }
    if (handler.done) CloseHandle(handler.done);
    if (handler.ftm) handler.ftm->lpVtbl->Release(handler.ftm);
    return hr;
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

static DWORD resolvePid(int argc, char **argv, VC_PROCESS_LOOPBACK_MODE *mode) {
    const char *m = argv[1];
    const char *v = argv[2];
    DWORD pid = 0;

    if (!strcmp(m, "include-pid")) {
        *mode = VC_PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
        pid = (DWORD)strtoul(v, NULL, 10);
    } else if (!strcmp(m, "include-hwnd")) {
        *mode = VC_PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
        HWND hwnd = (HWND)(uintptr_t)strtoull(v, NULL, 10);
        if (!hwnd || !IsWindow(hwnd)) fail("hwnd is not a valid window");
        GetWindowThreadProcessId(hwnd, &pid);
        if (!pid) fail("cannot resolve pid from hwnd");
    } else if (!strcmp(m, "exclude-pid")) {
        *mode = VC_PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
        pid = (DWORD)strtoul(v, NULL, 10);
    } else {
        fail("unknown mode");
    }
    if (!pid) fail("pid is 0");
    return pid;
}

int main(int argc, char **argv) {
    VC_PROCESS_LOOPBACK_MODE mode;
    DWORD pid;
    HRESULT hr;
    void *audioClientVoid = NULL;
    IAudioClient *client;
    IAudioClient2 *client2 = NULL;
    IAudioCaptureClient *capture = NULL;
    AudioClientProperties props;
    WAVEFORMATEX wfx;
    HANDLE event;
    static BYTE zeros[8192];

    if (argc < 3) {
        fprintf(stderr, "ERR usage: p2paudio.exe include-pid|include-hwnd|exclude-pid <id>\n");
        return 2;
    }

    if (!isWin10_2004())
        fail("requires Windows 10 2004 (build 19041)+");

    pid = resolvePid(argc, argv, &mode);

    /* stdout в бинарный режим — иначе CRT портит поток (\n -> \r\n) */
    _setmode(_fileno(stdout), _O_BINARY);
    _setmode(_fileno(stderr), _O_BINARY);

    hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) fail("CoInitializeEx failed");

    hr = activateLoopback(pid, mode, &audioClientVoid);
    if (FAILED(hr)) {
        char buf[128];
        snprintf(buf, sizeof(buf), "activation failed at %s: 0x%08lX", g_stage, (unsigned long)hr);
        fail(buf);
    }
    client = (IAudioClient *)audioClientVoid;

    hr = client->lpVtbl->QueryInterface(client, &IID_IAudioClient2, (void **)&client2);
    if (SUCCEEDED(hr) && client2) {
        ZeroMemory(&props, sizeof(props));
        props.cbSize = sizeof(props);
        props.bIsOffload = FALSE;
        props.eCategory = AudioCategory_GameMedia;
        props.Options = 0;
        /* не обязательно для loopback-захвата: при отказе просто продолжаем */
        (void)client2->lpVtbl->SetClientProperties(client2, &props);
        client2->lpVtbl->Release(client2);
        client2 = NULL;
    }

    ZeroMemory(&wfx, sizeof(wfx));
    wfx.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    wfx.nChannels = 2;
    wfx.nSamplesPerSec = 48000;
    wfx.wBitsPerSample = 32;
    wfx.nBlockAlign = 8;
    wfx.nAvgBytesPerSec = 48000 * 8;
    wfx.cbSize = 0;

    hr = client->lpVtbl->Initialize(client, VC_SHAREMODE_SHARED,
                                    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                    200000, 0, &wfx, NULL);
    if (FAILED(hr)) {
        char buf[128];
        snprintf(buf, sizeof(buf), "Initialize failed: 0x%08lX", (unsigned long)hr);
        fail(buf);
    }

    event = CreateEventW(NULL, FALSE, FALSE, NULL);
    hr = client->lpVtbl->SetEventHandle(client, event);
    if (FAILED(hr)) fail("SetEventHandle failed");

    hr = client->lpVtbl->GetService(client, &IID_IAudioCaptureClient, (void **)&capture);
    if (FAILED(hr)) fail("GetService(IAudioCaptureClient) failed");

    hr = client->lpVtbl->Start(client);
    if (FAILED(hr)) fail("Start failed");

    fprintf(stderr, "READY\n");
    fflush(stderr);

    ZeroMemory(zeros, sizeof(zeros));

    for (;;) {
        DWORD w = WaitForSingleObject(event, 2000);
        if (w != WAIT_OBJECT_0) {
            /* нет событий — тишина в источнике, ждём дальше */
            if (ferror(stdout)) goto finish;
            continue;
        }

        for (;;) {
            UINT32 packet = 0;
            if (FAILED(capture->lpVtbl->GetNextPacketSize(capture, &packet)) || packet == 0)
                break;

            BYTE *data = NULL;
            UINT32 frames = 0;
            DWORD flags = 0;
            if (FAILED(capture->lpVtbl->GetBuffer(capture, &data, &frames, &flags, NULL, NULL)))
                break;

            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                size_t bytes = (size_t)frames * 8;
                while (bytes > 0) {
                    size_t n = bytes < sizeof(zeros) ? bytes : sizeof(zeros);
                    fwrite(zeros, 1, n, stdout);
                    bytes -= n;
                }
            } else if (data) {
                fwrite(data, 8, frames, stdout);
            }

            capture->lpVtbl->ReleaseBuffer(capture, frames);

            if (ferror(stdout)) goto finish; /* родитель закрыл поток */
        }

        fflush(stdout);

        if (ferror(stdout)) goto finish;
    }

finish:
    client->lpVtbl->Stop(client);
    if (capture) capture->lpVtbl->Release(capture);
    client->lpVtbl->Release(client);
    CoUninitialize();
    return 0;
}

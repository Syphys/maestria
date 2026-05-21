# Maestria sandbox launcher — Windows Job Object isolation for slice 2d.
#
# Wraps a single python.exe invocation in a Win32 Job Object created via
# P/Invoke (no external dependency — `kernel32.dll` ships with Windows).
# Limits applied:
#   - JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 1  (T2/T7: no sub-process)
#   - JOB_OBJECT_LIMIT_PROCESS_MEMORY  ≈ 512 MiB by default (T6)
#   - JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (kill arbre at exit)
#
# Audit fix #6 (2026-05-21): python is now created via CreateProcess
# with CREATE_SUSPENDED. The process exists but no instruction runs
# until we explicitly call ResumeThread — and we ResumeThread ONLY
# AFTER AssignProcessToJobObject. Previously, Process.Start started
# python immediately and there was a ~5–30 ms race window where the
# child ran unconstrained before being assigned to the Job. That
# window is now closed at the kernel level.
#
# Output protocol: stdout/stderr from the child are captured via
# inheritable anonymous pipes and replayed between marker lines
# (__SANDBOX_STDOUT_BEGIN__ / __END__ / __SANDBOX_STDERR_BEGIN__ /
# __END__) so the parent (windows.ts) can disentangle them from
# the PowerShell layer's own noise.
#
# Exit codes (consumed by windows.ts):
#   0   — child exited 0 (asserts passed)
#   124 — timed out (we terminated the Job)
#   N   — child's own exit code, propagated
#   2   — internal launcher error (Job creation failed, P/Invoke broke,
#         CreateProcess returned false, etc.)

param(
    [Parameter(Mandatory=$true)][string]$PythonExe,
    [Parameter(Mandatory=$true)][string]$ScriptPath,
    [Parameter(Mandatory=$true)][int]$TimeoutMs,
    [Parameter(Mandatory=$true)][string]$WorkDir,
    [Parameter(Mandatory=$false)][long]$MemoryLimitBytes = 536870912
)

$ErrorActionPreference = "Stop"

# ----------------------------------------------------------------------
# P/Invoke surface — declared inline to keep the launcher self-contained.
# Extended in fix #6 with CreateProcess + ResumeThread + pipe APIs so we
# can spawn python SUSPENDED, assign it to the Job, then resume it.
# ----------------------------------------------------------------------
$source = @"
using System;
using System.Runtime.InteropServices;

public static class JobNative {
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetInformationJobObject(
        IntPtr hJob,
        int JobObjectInfoClass,
        IntPtr lpJobObjectInfo,
        uint cbJobObjectInfoLength
    );

    [DllImport("kernel32", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);
}

public static class WinProc {
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CreateProcess(
        string lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation
    );

    [DllImport("kernel32", SetLastError=true)]
    public static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32", SetLastError=true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CreatePipe(
        out IntPtr hReadPipe,
        out IntPtr hWritePipe,
        ref SECURITY_ATTRIBUTES lpPipeAttributes,
        uint nSize
    );

    [DllImport("kernel32", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ReadFile(
        IntPtr hFile,
        byte[] lpBuffer,
        uint nNumberOfBytesToRead,
        out uint lpNumberOfBytesRead,
        IntPtr lpOverlapped
    );

    public const uint STARTF_USESTDHANDLES = 0x00000100;
    public const uint CREATE_SUSPENDED = 0x4;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    public const uint CREATE_NO_WINDOW = 0x08000000;
    public const uint HANDLE_FLAG_INHERIT = 1;
    public const uint WAIT_TIMEOUT = 0x102;
}

[StructLayout(LayoutKind.Sequential)]
public struct SECURITY_ATTRIBUTES {
    public uint nLength;
    public IntPtr lpSecurityDescriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
}

[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct STARTUPINFO {
    public uint cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public uint dwX;
    public uint dwY;
    public uint dwXSize;
    public uint dwYSize;
    public uint dwXCountChars;
    public uint dwYCountChars;
    public uint dwFillAttribute;
    public uint dwFlags;
    public ushort wShowWindow;
    public ushort cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
}

[StructLayout(LayoutKind.Sequential)]
public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
}

[StructLayout(LayoutKind.Sequential)]
public struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
}

[StructLayout(LayoutKind.Sequential)]
public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long  PerProcessUserTimeLimit;
    public long  PerJobUserTimeLimit;
    public uint  LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint  ActiveProcessLimit;
    public IntPtr Affinity;
    public uint  PriorityClass;
    public uint  SchedulingClass;
}

[StructLayout(LayoutKind.Sequential)]
public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
}
"@

try {
    Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
} catch {
    Write-Error "Add-Type failed: $($_.Exception.Message)"
    exit 2
}

# ----------------------------------------------------------------------
# Helper — drain a pipe handle until EOF (write end closed). Returns
# the captured text decoded as UTF-8.
# ----------------------------------------------------------------------
function Read-PipeToEnd {
    param([IntPtr]$handle)
    $buffer = New-Object byte[] 4096
    $sb = New-Object System.Text.StringBuilder
    while ($true) {
        $bytesRead = [uint32]0
        $ok = [WinProc]::ReadFile($handle, $buffer, 4096, [ref]$bytesRead, [IntPtr]::Zero)
        if (-not $ok) { break }              # ERROR_BROKEN_PIPE when child closed its end
        if ($bytesRead -eq 0) { break }      # EOF
        [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $bytesRead))
    }
    return $sb.ToString()
}

# Constants — Win32 docs values, kept as variables for readability.
$JOB_OBJECT_LIMIT_ACTIVE_PROCESS       = 0x00000008
$JOB_OBJECT_LIMIT_PROCESS_MEMORY       = 0x00000100
$JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE    = 0x00002000
$JobObjectExtendedLimitInformation     = 9

# ----------------------------------------------------------------------
# 1. Create the Job and arm the limits.
# ----------------------------------------------------------------------
$job = [JobNative]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) {
    Write-Error "CreateJobObject failed"
    exit 2
}

# Tracked handles for the `finally` cleanup.
$hOutR = [IntPtr]::Zero; $hOutW = [IntPtr]::Zero
$hErrR = [IntPtr]::Zero; $hErrW = [IntPtr]::Zero
$pi = New-Object PROCESS_INFORMATION
$envPtr = [IntPtr]::Zero

try {
    # ------------------------------------------------------------------
    # 1a. Apply Job limits (must succeed BEFORE we attach the process).
    # ------------------------------------------------------------------
    $limit = New-Object JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    $limit.BasicLimitInformation.LimitFlags = `
        $JOB_OBJECT_LIMIT_ACTIVE_PROCESS -bor `
        $JOB_OBJECT_LIMIT_PROCESS_MEMORY -bor `
        $JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    $limit.BasicLimitInformation.ActiveProcessLimit = 1
    $limit.ProcessMemoryLimit = [UIntPtr]::new([uint64]$MemoryLimitBytes)

    $size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][JOBOBJECT_EXTENDED_LIMIT_INFORMATION])
    $ptr  = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
    try {
        [System.Runtime.InteropServices.Marshal]::StructureToPtr($limit, $ptr, $false)
        $ok = [JobNative]::SetInformationJobObject($job, $JobObjectExtendedLimitInformation, $ptr, [uint32]$size)
        if (-not $ok) {
            Write-Error "SetInformationJobObject failed"
            exit 2
        }
    } finally {
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
    }

    # ------------------------------------------------------------------
    # 2. Create inheritable anonymous pipes for stdout / stderr.
    # ------------------------------------------------------------------
    $sa = New-Object SECURITY_ATTRIBUTES
    $sa.nLength = [System.Runtime.InteropServices.Marshal]::SizeOf([type][SECURITY_ATTRIBUTES])
    $sa.bInheritHandle = $true

    if (-not [WinProc]::CreatePipe([ref]$hOutR, [ref]$hOutW, [ref]$sa, 0)) {
        Write-Error "CreatePipe(stdout) failed"; exit 2
    }
    if (-not [WinProc]::CreatePipe([ref]$hErrR, [ref]$hErrW, [ref]$sa, 0)) {
        Write-Error "CreatePipe(stderr) failed"; exit 2
    }
    # READ ends must NOT be inherited — only the parent (us) reads them.
    # Otherwise the child holds a reader and ReadFile in the parent never
    # gets ERROR_BROKEN_PIPE / EOF on the child's death.
    [void][WinProc]::SetHandleInformation($hOutR, [WinProc]::HANDLE_FLAG_INHERIT, 0)
    [void][WinProc]::SetHandleInformation($hErrR, [WinProc]::HANDLE_FLAG_INHERIT, 0)

    # ------------------------------------------------------------------
    # 3. Build the environment block: emptied, then a minimal whitelist.
    #    Wide-char, double-NUL terminated.
    # ------------------------------------------------------------------
    $envBlock = "SystemRoot=$($env:SystemRoot)`0" `
              + "PATH=$($env:SystemRoot)\System32`0" `
              + "PYTHONIOENCODING=utf-8`0`0"
    $envPtr = [System.Runtime.InteropServices.Marshal]::StringToHGlobalUni($envBlock)

    # ------------------------------------------------------------------
    # 4. Set up STARTUPINFO with the WRITE ends of our pipes.
    # ------------------------------------------------------------------
    $si = New-Object STARTUPINFO
    $si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf([type][STARTUPINFO])
    $si.dwFlags = [WinProc]::STARTF_USESTDHANDLES
    $si.hStdInput = [IntPtr]::Zero
    $si.hStdOutput = $hOutW
    $si.hStdError = $hErrW

    # ------------------------------------------------------------------
    # 5. Create the process SUSPENDED — kernel allocates it but no
    #    instruction runs yet. Audit fix #6: this closes the race
    #    window that existed with Process.Start().
    # ------------------------------------------------------------------
    $cmdLine = "$PythonExe -I -S -B `"$ScriptPath`""
    $creationFlags = [WinProc]::CREATE_SUSPENDED -bor `
                     [WinProc]::CREATE_UNICODE_ENVIRONMENT -bor `
                     [WinProc]::CREATE_NO_WINDOW
    $ok = [WinProc]::CreateProcess(
        $null,
        $cmdLine,
        [IntPtr]::Zero, [IntPtr]::Zero,
        $true,                  # bInheritHandles — pipe write-ends inherit
        $creationFlags,
        $envPtr,
        $WorkDir,
        [ref]$si,
        [ref]$pi
    )
    if (-not $ok) {
        $lastErr = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Error "CreateProcess failed: Win32 error $lastErr"
        exit 2
    }

    # ------------------------------------------------------------------
    # 6. Now SAFE to assign to the Job — the process is still suspended,
    #    no user code has run. Audit fix #6: race window closed.
    # ------------------------------------------------------------------
    if (-not [JobNative]::AssignProcessToJobObject($job, $pi.hProcess)) {
        [void][WinProc]::TerminateProcess($pi.hProcess, 1)
        Write-Error "AssignProcessToJobObject failed"
        exit 2
    }

    # ------------------------------------------------------------------
    # 7. Close the pipe WRITE-ends in the parent. The child still has
    #    its inherited copies. When the child exits, those die with it
    #    and ReadFile in the parent returns ERROR_BROKEN_PIPE.
    # ------------------------------------------------------------------
    [void][JobNative]::CloseHandle($hOutW); $hOutW = [IntPtr]::Zero
    [void][JobNative]::CloseHandle($hErrW); $hErrW = [IntPtr]::Zero

    # ------------------------------------------------------------------
    # 8. ResumeThread — the child's code starts running, now INSIDE
    #    the Job (limits enforced from instruction zero).
    # ------------------------------------------------------------------
    [void][WinProc]::ResumeThread($pi.hThread)

    # ------------------------------------------------------------------
    # 9. Wait with timeout. WAIT_TIMEOUT (0x102) ⇒ kill the Job.
    # ------------------------------------------------------------------
    $waitResult = [WinProc]::WaitForSingleObject($pi.hProcess, [uint32]$TimeoutMs)
    if ($waitResult -eq [WinProc]::WAIT_TIMEOUT) {
        [void][JobNative]::TerminateJobObject($job, 1)
        [void][WinProc]::WaitForSingleObject($pi.hProcess, 1000)
        $exitCode = 124
    } else {
        $exit = [uint32]0
        [void][WinProc]::GetExitCodeProcess($pi.hProcess, [ref]$exit)
        $exitCode = $exit
    }

    # ------------------------------------------------------------------
    # 10. Drain captured streams; replay with markers; propagate exit.
    # ------------------------------------------------------------------
    $stdout = Read-PipeToEnd $hOutR
    $stderr = Read-PipeToEnd $hErrR

    Write-Output "__SANDBOX_STDOUT_BEGIN__"
    if ($stdout) { Write-Output $stdout }
    Write-Output "__SANDBOX_STDOUT_END__"
    Write-Output "__SANDBOX_STDERR_BEGIN__"
    if ($stderr) { Write-Output $stderr }
    Write-Output "__SANDBOX_STDERR_END__"

    exit $exitCode
} finally {
    if ($pi.hThread -ne [IntPtr]::Zero) { [void][JobNative]::CloseHandle($pi.hThread) }
    if ($pi.hProcess -ne [IntPtr]::Zero) { [void][JobNative]::CloseHandle($pi.hProcess) }
    if ($hOutR -ne [IntPtr]::Zero) { [void][JobNative]::CloseHandle($hOutR) }
    if ($hOutW -ne [IntPtr]::Zero) { [void][JobNative]::CloseHandle($hOutW) }
    if ($hErrR -ne [IntPtr]::Zero) { [void][JobNative]::CloseHandle($hErrR) }
    if ($hErrW -ne [IntPtr]::Zero) { [void][JobNative]::CloseHandle($hErrW) }
    if ($envPtr -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($envPtr) }
    [void][JobNative]::CloseHandle($job)
}

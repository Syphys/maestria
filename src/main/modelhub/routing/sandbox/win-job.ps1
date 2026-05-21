# Maestria sandbox launcher — Windows Job Object isolation for slice 2d.
#
# Wraps a single python.exe invocation in a Win32 Job Object created via
# P/Invoke (no external dependency — `kernel32.dll` ships with Windows).
# Limits applied:
#   - JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 1  (T2/T7: no sub-process)
#   - JOB_OBJECT_LIMIT_PROCESS_MEMORY  ≈ 512 MiB by default (T6)
#   - JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (kill arbre at exit)
#
# Output protocol: stdout/stderr from the child are captured and replayed
# between marker lines (__SANDBOX_STDOUT_BEGIN__ / __END__ /
# __SANDBOX_STDERR_BEGIN__ / __END__) so the parent (windows.ts) can
# disentangle them from the PowerShell layer's own noise.
#
# Exit codes (consumed by windows.ts):
#   0   — child exited 0 (asserts passed)
#   124 — timed out (we terminated the job)
#   N   — child's own exit code, propagated
#   2   — internal launcher error (Job creation failed, P/Invoke broke,
#         python.exe couldn't even be started)

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

    [DllImport("kernel32", SetLastError=true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    public const uint PROCESS_ALL_ACCESS = 0x1F0FFF;
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

try {
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
    # 2. Start python with an emptied env + cwd at the disposable workdir.
    # ------------------------------------------------------------------
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $PythonExe
    $psi.Arguments              = "-I -S -B `"$ScriptPath`""
    $psi.UseShellExecute        = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.WorkingDirectory       = $WorkDir
    $psi.CreateNoWindow         = $true

    # Empty inherited env, keep only the minimum a Python 3 child needs
    # on Windows. SystemRoot is required for `kernel32` to load at all;
    # PATH is whittled down to System32 so the child can't invoke
    # arbitrary user-PATH binaries even if it manages to subprocess.
    $psi.EnvironmentVariables.Clear()
    $psi.EnvironmentVariables.Add("SystemRoot", $env:SystemRoot)
    $psi.EnvironmentVariables.Add("PATH",       (Join-Path $env:SystemRoot "System32"))
    # Force UTF-8 output so PowerShell capture is not locale-dependent.
    $psi.EnvironmentVariables.Add("PYTHONIOENCODING", "utf-8")

    $proc = $null
    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
    } catch {
        Write-Error "Process.Start failed: $($_.Exception.Message)"
        exit 2
    }
    if ($proc -eq $null) {
        Write-Error "Process.Start returned null"
        exit 2
    }

    # ------------------------------------------------------------------
    # 3. Assign to the Job (best-effort: tiny race window — see
    #    SECURITY-sandbox-2d.md §5.4 for the residual analysis).
    # ------------------------------------------------------------------
    $hProc = [JobNative]::OpenProcess([JobNative]::PROCESS_ALL_ACCESS, $false, $proc.Id)
    if ($hProc -ne [IntPtr]::Zero) {
        [void][JobNative]::AssignProcessToJobObject($job, $hProc)
        [void][JobNative]::CloseHandle($hProc)
    }

    # ------------------------------------------------------------------
    # 4. Wait with timeout.
    # ------------------------------------------------------------------
    $exited = $proc.WaitForExit($TimeoutMs)
    if (-not $exited) {
        [void][JobNative]::TerminateJobObject($job, 1)
        $proc.WaitForExit(1000) | Out-Null
        exit 124
    }

    # ------------------------------------------------------------------
    # 5. Replay captured streams with markers, then propagate exit code.
    # ------------------------------------------------------------------
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()

    Write-Output "__SANDBOX_STDOUT_BEGIN__"
    if ($stdout) { Write-Output $stdout }
    Write-Output "__SANDBOX_STDOUT_END__"
    Write-Output "__SANDBOX_STDERR_BEGIN__"
    if ($stderr) { Write-Output $stderr }
    Write-Output "__SANDBOX_STDERR_END__"

    exit $proc.ExitCode
} finally {
    [void][JobNative]::CloseHandle($job)
}

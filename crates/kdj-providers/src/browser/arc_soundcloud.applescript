-- KDJ owns no browser settings. Both macOS Automation and Arc's JavaScript switch are user grants.
-- Only the active window is used; a new tab inherits its current Space/Profile.
set currentStage to "connect"
try
with timeout of 8 seconds
    tell application __ARC_APP__
        if not running then return "{\"status\":\"not_running\"}"
        if (count of windows) is 0 then return "{\"status\":\"no_window\"}"
        set currentStage to "window"
        set targetWindow to a reference to front window
        set currentStage to "active_tab"
        set targetTab to a reference to active tab of targetWindow
        set currentStage to "tab_url"
        set tabURL to URL of targetTab
        if tabURL is missing value then set tabURL to ""
        set currentStage to "check_url"
        if tabURL is not __SITE_ORIGIN__ and tabURL does not start with __SITE_URL__ then
            if not __ALLOW_OPEN__ then return "{\"status\":\"wrong_site\"}"
            set currentStage to "create_tab"
            tell targetWindow to make new tab with properties {URL:__SITE_URL__}
            -- Finish this Apple Event before reading the new page. Arc can report
            -- loading=false before the new tab's JavaScript interface is ready.
            return "{\"status\":\"opened\"}"
        end if
        set currentStage to "loading"
        if loading of targetTab then return "{\"status\":\"loading\"}"
        set currentStage to "execute"
        with timeout of 3 seconds
            return execute targetTab javascript __COOKIE_SCRIPT__
        end timeout
    end tell
end timeout
on error errorMessage number errorNumber
    if errorNumber is -1743 then return "{\"status\":\"permission_denied\"}"
    if errorNumber is -1712 and currentStage is "execute" then return "{\"status\":\"loading\"}"
    if errorMessage contains "JavaScript" then return "{\"status\":\"javascript_disabled\"}"
    return "{\"status\":\"script_error\",\"stage\":\"" & currentStage & "\",\"code\":" & errorNumber & "}"
end try

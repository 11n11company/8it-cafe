import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, getToken, setToken, clearToken } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setTokenState] = useState(getToken());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Fetch current user and session profile from backend
  const refreshUser = useCallback(async () => {
    const activeToken = getToken();
    if (!activeToken) {
      setUser(null);
      setLoading(false);
      return;
    }

    try {
      const res = await api.auth.getMe();
      if (res && res.data && res.data.user) {
        setUser(res.data.user);
      }
    } catch (err) {
      // If token expired or invalid, clear it
      if (err.statusCode === 401) {
        clearToken();
        setTokenState(null);
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUser();

    // Listen for custom token expiry events dispatched by api client
    const handleExpired = () => {
      clearToken();
      setTokenState(null);
      setUser(null);
    };

    window.addEventListener('cafe_auth_expired', handleExpired);
    return () => window.removeEventListener('cafe_auth_expired', handleExpired);
  }, [refreshUser]);

  // Login handler
  const login = async (username, password) => {
    setError(null);
    try {
      const res = await api.auth.login(username, password);
      const { token: newToken, user: userData } = res.data;
      setToken(newToken);
      setTokenState(newToken);
      setUser(userData);
      return userData;
    } catch (err) {
      setError(err.message || 'Login failed');
      throw err;
    }
  };

  // Quick Cashier Switch with 4-Digit PIN
  const switchCashier = async (targetUserId, pin) => {
    setError(null);
    try {
      const res = await api.auth.switchCashier(targetUserId, pin);
      const { token: freshToken, user: targetUser } = res.data;
      setToken(freshToken);
      setTokenState(freshToken);
      setUser(targetUser);
      return targetUser;
    } catch (err) {
      setError(err.message || 'PIN authentication failed');
      throw err;
    }
  };

  // Logout handler
  const logout = async () => {
    try {
      if (getToken()) {
        await api.auth.logout();
      }
    } catch {
      // Ignore network errors on logout
    } finally {
      clearToken();
      setTokenState(null);
      setUser(null);
    }
  };

  // Permission check helper
  const hasPermission = useCallback((permissionCode) => {
    if (!user) return false;
    const roleCode = user.role?.code || user.role;
    if (roleCode === 'ADMIN') return true; // Administrator inherits all capabilities
    const perms = user.permissions || [];
    return perms.includes(permissionCode);
  }, [user]);

  // Role check helper
  const hasRole = useCallback((...allowedRoles) => {
    if (!user) return false;
    const roleCode = (user.role?.code || user.role || '').toUpperCase();
    return allowedRoles.map(r => r.toUpperCase()).includes(roleCode);
  }, [user]);

  const value = {
    user,
    token,
    role: (user?.role?.code || user?.role || '').toUpperCase(),
    company: user?.company || null,
    permissions: user?.permissions || [],
    isAuthenticated: !!user && !!token,
    loading,
    error,
    login,
    switchCashier,
    logout,
    hasPermission,
    hasRole,
    refreshUser
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

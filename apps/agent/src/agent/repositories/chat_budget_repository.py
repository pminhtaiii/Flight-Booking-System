from datetime import datetime, timezone, timedelta
import redis.asyncio as redis

class ChatBudgetException(Exception):
    pass

class BudgetExceededException(ChatBudgetException):
    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(f"Budget exceeded: {reason}")

class RedisUnavailableException(ChatBudgetException):
    def __init__(self, message: str):
        super().__init__(f"Redis unavailable: {message}")

class ChatBudgetRepository:
    """
    Repository for enforcing daily and burst rate limits atomically using a single Lua script in Redis.
    """
    
    LUA_SCRIPT = """
    local daily_key = KEYS[1]
    local burst_key = KEYS[2]
    
    local daily_limit = tonumber(ARGV[1])
    local burst_limit = tonumber(ARGV[2])
    local daily_ttl = tonumber(ARGV[3])
    local burst_ttl = tonumber(ARGV[4])
    
    local current_daily = tonumber(redis.call('get', daily_key) or '0')
    local current_burst = tonumber(redis.call('get', burst_key) or '0')
    
    if current_daily >= daily_limit then
        return {0, 'daily_quota_exceeded'}
    end
    
    if current_burst >= burst_limit then
        return {0, 'burst_quota_exceeded'}
    end
    
    redis.call('incr', daily_key)
    if current_daily == 0 then
        redis.call('expire', daily_key, daily_ttl)
    end
    
    redis.call('incr', burst_key)
    if current_burst == 0 then
        redis.call('expire', burst_key, burst_ttl)
    end
    
    return {1, 'ok'}
    """

    def __init__(self, redis_client: redis.Redis):
        self.redis = redis_client

    def _get_daily_ttl(self) -> int:
        now = datetime.now(timezone.utc)
        tomorrow = now + timedelta(days=1)
        next_midnight = tomorrow.replace(hour=0, minute=0, second=0, microsecond=0)
        return int((next_midnight - now).total_seconds())

    async def admit_request(self, user_id: str, burst_window_id: str, daily_limit: int, burst_limit: int, burst_ttl: int = 60) -> bool:
        """
        Atomically increment burst and daily budgets. 
        Returns True if admitted. Raises BudgetExceededException if rejected.
        Raises RedisUnavailableException if Redis fails.
        """
        daily_date = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        daily_key = f"chat:budget:{user_id}:{daily_date}"
        burst_key = f"chat:burst:{user_id}:{burst_window_id}"
        
        daily_ttl = self._get_daily_ttl()
        
        try:
            result = await self.redis.eval(
                self.LUA_SCRIPT,
                2,
                daily_key, burst_key,
                daily_limit, burst_limit, daily_ttl, burst_ttl
            )
            
            admitted = result[0]
            reason = result[1]
            
            if not admitted:
                # Need to decode from bytes if redis client doesn't decode automatically
                if isinstance(reason, bytes):
                    reason = reason.decode('utf-8')
                raise BudgetExceededException(reason)
                
            return True
            
        except BudgetExceededException:
            raise
        except redis.RedisError as e:
            raise RedisUnavailableException(str(e))

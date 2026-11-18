package com.jankonradk.commuteer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.json.JSONArray;
import org.junit.Test;

public class JourneyMathTest {
    private static JSONArray stops(String json) throws Exception {
        return new JSONArray(json);
    }

    @Test
    public void carriesTheLatestEarlierDelay() throws Exception {
        JSONArray s = stops("[[3,\"a\",60,90,false],[7,\"b\",120,null,false],[12,\"c\",300,300,false]]");
        assertEquals(Integer.valueOf(120), JourneyMath.delayAt(s, 7, true));
        assertEquals(Integer.valueOf(120), JourneyMath.delayAt(s, 9, false));
        assertEquals(Integer.valueOf(90), JourneyMath.delayAt(s, 5, true));
        assertNull(JourneyMath.delayAt(s, 2, true));
    }

    @Test
    public void ignoresSkippedStops() throws Exception {
        JSONArray s = stops("[[3,\"a\",60,60,false],[5,\"b\",600,600,true]]");
        assertEquals(Integer.valueOf(60), JourneyMath.delayAt(s, 6, true));
    }

    @Test
    public void formatsTimes() {
        assertEquals("in 5 min", JourneyMath.until(5 * 60000));
        assertEquals("in 1 h 10 min", JourneyMath.until(70 * 60000));
        assertEquals("now", JourneyMath.until(-1000));
        assertEquals("3 min late", JourneyMath.delayText(180));
        assertEquals("on time", JourneyMath.delayText(20));
    }
}

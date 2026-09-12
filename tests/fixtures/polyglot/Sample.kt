package org.example

import org.example.util.Helper

class MainActivity : BaseActivity() {
    fun run(value: Int): String {
        Helper.process(value)
        return value.toString()
    }
}

fun topLevel() = MainActivity()
